import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptRequest } from '@agentclientprotocol/sdk'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const promptParams = (sessionId: string, text: string): PromptRequest => ({
  sessionId,
  prompt: [{ type: 'text', text }]
})

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('PiAcpAgent: closeSession cancels in-flight work, flushes updates, and frees only live resources', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager

  const session = manager.getOrCreate('s-close', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  const inFlight = session.prompt('long running work')
  const queued = session.prompt('queued work')

  // Stream a partial update for the in-flight turn.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })

  let resolved = false
  let updatesAtResolve = -1
  const tracked = inFlight.then(reason => {
    resolved = true
    updatesAtResolve = conn.updates.length
    return reason
  })

  const closeResult = await agent.closeSession({ sessionId: 's-close' })
  assert.deepEqual(closeResult, {})

  // The close response is only sent after every outstanding prompt settled.
  assert.ok(resolved, 'in-flight prompt settled before session/close responded')
  assert.equal(await tracked, 'cancelled')
  assert.equal(await queued, 'cancelled')

  // In-flight pi work was aborted and the subprocess disposed exactly once.
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(manager.maybeGet('s-close'), undefined)

  const updatesAfterClose = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'too late' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(conn.updates.length, updatesAfterClose, 'late subprocess events are detached after close')

  // Final updates were flushed before the prompt settled.
  const delivered = conn.updates.map(u => u.update)
  const deltaIndex = delivered.findIndex(
    u => u.sessionUpdate === 'agent_message_chunk' && (u as any).content?.text === 'partial'
  )
  assert.ok(deltaIndex >= 0, 'streamed update was delivered')
  assert.ok(updatesAtResolve > deltaIndex, 'updates flushed before the prompt settled')
})

test('PiAcpAgent: closeSession rejects prompt admission while abort is in flight', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const session = manager.getOrCreate('s-close-race', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  const active = session.prompt('active work')
  const abortStarted = deferred<void>()
  const releaseAbort = deferred<void>()
  proc.abort = async () => {
    proc.abortCount += 1
    abortStarted.resolve()
    await releaseAbort.promise
  }

  const close = agent.closeSession({ sessionId: 's-close-race' })
  await abortStarted.promise

  const raced = session.prompt('must not start')
  assert.equal(await withTimeout(raced, 'raced session/prompt'), 'cancelled')
  assert.equal(proc.prompts.length, 1, 'shutdown did not send the raced prompt to pi')

  releaseAbort.resolve()
  assert.deepEqual(await withTimeout(close, 'session/close'), {})
  assert.equal(await active, 'cancelled')
  assert.equal(proc.disposeCount, 1)
})

test('PiAcpAgent: close waits for adapter commands, cancels them, and closes admission', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  manager.getOrCreate('s-compact-close', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  const compactStarted = deferred<void>()
  const compactResult = deferred<unknown>()
  let compactCalls = 0
  ;(proc as any).compact = async () => {
    compactCalls += 1
    compactStarted.resolve()
    return compactResult.promise
  }

  const abortStarted = deferred<void>()
  const releaseAbort = deferred<void>()
  proc.abort = async () => {
    proc.abortCount += 1
    abortStarted.resolve()
    await releaseAbort.promise
  }

  const dispose = proc.dispose.bind(proc)
  proc.dispose = () => {
    dispose()
    compactResult.reject(new Error('pi process exited (code=null, signal=SIGTERM)'))
  }

  const settlementOrder: string[] = []
  const prompt = agent.prompt(promptParams('s-compact-close', '/compact')).then(result => {
    settlementOrder.push('prompt')
    return result
  })
  await compactStarted.promise

  const close = agent.closeSession({ sessionId: 's-compact-close' }).then(result => {
    settlementOrder.push('close')
    return result
  })
  await abortStarted.promise

  const raced = agent.prompt(promptParams('s-compact-close', '/compact again'))
  assert.equal((await withTimeout(raced, 'raced adapter prompt')).stopReason, 'cancelled')
  assert.equal(compactCalls, 1, 'close admission prevented a second adapter command')

  let closeSettled = false
  void close.then(() => {
    closeSettled = true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(closeSettled, false, 'session/close waited while the tracked prompt was active')

  releaseAbort.resolve()

  assert.deepEqual(await withTimeout(close, 'adapter-command session/close'), {})
  assert.equal((await withTimeout(prompt, 'adapter command prompt')).stopReason, 'cancelled')
  assert.deepEqual(settlementOrder, ['prompt', 'close'])
  assert.equal(proc.disposeCount, 1)
  assert.equal(manager.maybeGet('s-compact-close'), undefined)

  const updatesAfterClose = conn.updates.length
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(conn.updates.length, updatesAfterClose, 'cancelled adapter command emitted no update after close')
})

test('PiAcpSession: cancel flushes queue-cleared updates before queued responses', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's-cancel-order',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const updateStarted = deferred<void>()
  const releaseUpdate = deferred<void>()
  let blockedUpdateCompleted = false
  const deliverUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    await deliverUpdate(message)
    const update = message.update
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text' &&
      update.content.text === 'Cleared queued prompts.'
    ) {
      updateStarted.resolve()
      await releaseUpdate.promise
      blockedUpdateCompleted = true
    }
  }

  const active = session.prompt('active work')
  const queued = session.prompt('queued work')
  let queuedSettled = false
  void queued.then(() => {
    queuedSettled = true
  })

  const cancel = session.cancel()
  await updateStarted.promise
  assert.equal(queuedSettled, false, 'queued response waited for queue-cleared update delivery')

  releaseUpdate.resolve()
  await cancel
  assert.equal(await queued, 'cancelled')
  assert.equal(blockedUpdateCompleted, true)

  proc.emit({ type: 'agent_settled' })
  assert.equal(await active, 'cancelled')
})

test('PiAcpAgent: close flushes active updates before queued responses', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const session = manager.getOrCreate('s-close-order', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })
  const updateStarted = deferred<void>()
  const releaseUpdate = deferred<void>()
  let blockedUpdateCompleted = false
  const deliverUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    await deliverUpdate(message)
    const update = message.update
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text' &&
      update.content.text === 'final update before close'
    ) {
      updateStarted.resolve()
      await releaseUpdate.promise
      blockedUpdateCompleted = true
    }
  }

  const active = session.prompt('active work')
  const queued = session.prompt('queued work')
  let queuedSettled = false
  void queued.then(() => {
    queuedSettled = true
  })
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'final update before close' }
  })
  await updateStarted.promise

  const close = agent.closeSession({ sessionId: 's-close-order' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(queuedSettled, false, 'queued response waited for the active turn update')

  releaseUpdate.resolve()
  assert.deepEqual(await withTimeout(close, 'ordered session/close'), {})
  assert.equal(await active, 'cancelled')
  assert.equal(await queued, 'cancelled')
  assert.equal(blockedUpdateCompleted, true)
})

test('PiAcpAgent: public close invalidates a load during its private replacement teardown', async () => {
  const conn = new FakeAgentSideConnection()
  const oldProc = new FakePiRpcProcess()
  const replacementProc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-load-close-teardown'
  const cwd = process.cwd()

  manager.getOrCreate(sessionId, {
    cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: oldProc as any,
    fileCommands: []
  })
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd, sessionFile: '/tmp/session.jsonl' }),
    upsert: () => {},
    delete: () => {}
  }

  const abortStarted = deferred<void>()
  const releaseAbort = deferred<void>()
  oldProc.abort = async () => {
    oldProc.abortCount += 1
    abortStarted.resolve()
    await releaseAbort.promise
  }

  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return replacementProc
  }

  try {
    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    await abortStarted.promise

    const close = agent.closeSession({ sessionId })
    releaseAbort.resolve()

    await assert.rejects(load, /Request cancelled.*session closed while loading/i)
    assert.deepEqual(await withTimeout(close, 'load-teardown session/close'), {})
    assert.equal(oldProc.disposeCount, 1)
    assert.equal(spawnCount, 0, 'invalidated load did not spawn a replacement')
    assert.equal(replacementProc.disposeCount, 0)
    assert.equal(manager.maybeGet(sessionId), undefined)

    await agent.loadSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawnCount, 1, 'a new load is admitted after close finishes')
    assert.equal(manager.maybeGet(sessionId)?.proc, replacementProc as any)
    manager.close(sessionId)
  } finally {
    releaseAbort.resolve()
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: close waits for deferred load updates and leaves no restored process', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-load-close-replay'
  const cwd = process.cwd()
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd, sessionFile: '/tmp/session.jsonl' }),
    upsert: () => {},
    delete: () => {}
  }
  proc.getMessages = async () => ({
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'restored history' }] }]
  })

  const updateStarted = deferred<void>()
  const releaseUpdate = deferred<void>()
  const deliverUpdate = conn.sessionUpdate.bind(conn)
  let closeResponded = false
  let updatesAfterClose = 0
  conn.sessionUpdate = async update => {
    updateStarted.resolve()
    await releaseUpdate.promise
    if (closeResponded) updatesAfterClose += 1
    await deliverUpdate(update)
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    await updateStarted.promise

    const close = agent.closeSession({ sessionId }).then(result => {
      closeResponded = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(closeResponded, false, 'close waited for the blocked history update')
    assert.equal(proc.disposeCount, 1, 'close disposed the restored process while load was blocked')

    releaseUpdate.resolve()
    await assert.rejects(load, /Request cancelled.*session closed while loading/i)
    assert.deepEqual(await withTimeout(close, 'load-replay session/close'), {})
    assert.equal(manager.maybeGet(sessionId), undefined)
    assert.equal(proc.disposeCount, 1)
    assert.equal(updatesAfterClose, 0)

    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(updatesAfterClose, 0, 'load emitted no deferred updates after close responded')
  } finally {
    releaseUpdate.resolve()
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: restore persistence failure cannot leak its registered process', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-restore-store-failure'
  const cwd = process.cwd()
  let close: Promise<unknown> | undefined
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd, sessionFile: '/tmp/session.jsonl' }),
    upsert: () => {
      close = agent.closeSession({ sessionId })
      throw new Error('store write failed')
    },
    delete: () => {}
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    await assert.rejects(agent.loadSession({ sessionId, cwd, mcpServers: [] }), /store write failed/)
    assert.ok(close, 'close began after restore registered the session')
    assert.deepEqual(await withTimeout(close, 'failed-restore session/close'), {})
    assert.equal(manager.maybeGet(sessionId), undefined)
    assert.equal(proc.disposeCount, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: closeSession of an unknown session succeeds silently and keeps persistence intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-close-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-close-store-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  const sessionFile = join(sessionsDir, '0000_close.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'session', version: 3, id: 'sess-keep', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/p' }) +
      '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    assert.deepEqual(await agent.closeSession({ sessionId: 'sess-keep' }), {})
    assert.deepEqual(await agent.closeSession({ sessionId: 'never-existed' }), {})

    // Close never deletes persistence.
    assert.ok(existsSync(sessionFile))
    const listed = await agent.listSessions({})
    assert.deepEqual(
      listed.sessions.map(s => s.sessionId),
      ['sess-keep']
    )
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})

test('PiAcpAgent: deleteSession is idempotent and never unlinks tampered map paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-delete-store-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  const sessionFile = join(sessionsDir, '0000_delete.jsonl')
  const decoy = join(root, 'decoy.txt')

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'session', version: 3, id: 'sess-del', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/p' }) +
      '\n',
    'utf-8'
  )
  writeFileSync(decoy, 'must never be deleted', 'utf-8')

  // Tampered adapter map: points the sessionId at an arbitrary path.
  writeFileSync(
    join(acpDir, 'session-map.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        'sess-del': {
          sessionId: 'sess-del',
          cwd: '/p',
          sessionFile: decoy,
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    }),
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    assert.deepEqual(await agent.deleteSession({ sessionId: 'sess-del' }), {})

    // The genuine pi session file is gone; the tampered map target survives.
    assert.ok(!existsSync(sessionFile), 'real pi session file was deleted')
    assert.ok(existsSync(decoy), 'tampered map path was not unlinked')
    assert.equal(readFileSync(decoy, 'utf-8'), 'must never be deleted')

    // The adapter mapping was removed and the session no longer lists.
    const map = JSON.parse(readFileSync(join(acpDir, 'session-map.json'), 'utf-8'))
    assert.equal(map.sessions['sess-del'], undefined)
    assert.deepEqual((await agent.listSessions({})).sessions, [])

    // Deleting again (or deleting unknown ids) stays a silent success.
    assert.deepEqual(await agent.deleteSession({ sessionId: 'sess-del' }), {})
    assert.deepEqual(await agent.deleteSession({ sessionId: 'never-existed' }), {})
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})

test('PiAcpAgent: deleteSession closes an active session before removing persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-active-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-delete-active-store-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  const sessionFile = join(sessionsDir, '0000_delete_active.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-active',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/p'
    }) + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const manager = (agent as any).sessions as SessionManager

    const session = manager.getOrCreate('sess-active', {
      cwd: '/p',
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: proc as any,
      fileCommands: []
    })

    const inFlight = session.prompt('work')
    proc.emit({ type: 'agent_start' })

    assert.deepEqual(await agent.deleteSession({ sessionId: 'sess-active' }), {})

    assert.equal(await inFlight, 'cancelled')
    assert.equal(proc.disposeCount, 1)
    assert.equal(manager.maybeGet('sess-active'), undefined)
    assert.ok(!existsSync(sessionFile))
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})
