import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, methods, RequestError, type ClientConnection } from '@agentclientprotocol/sdk/unstable'
import { createPiAcpAgentApp } from '../../src/acp/app.js'
import type { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { defaultSessionDirectory } from '../../src/acp/session-repository.js'
import { encodeTitleWidget, TITLE_WIDGET } from '../../src/acp/session-title.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

let oldAgentDir: string | undefined
let oldAcpDir: string | undefined
let testCwd: string
let storePath: string
let connection: ClientConnection | null = null

beforeEach(() => {
  oldAgentDir = process.env.PI_CODING_AGENT_DIR
  oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-1b-agent-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-1b-store-'))
  testCwd = mkdtempSync(join(tmpdir(), 'pi-acp-1b-cwd-'))
  storePath = join(process.env.PI_ACP_DIR, 'session-map.json')
})

afterEach(() => {
  connection?.close()
  connection = null
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
  else process.env.PI_ACP_DIR = oldAcpDir
})

function writeSessionJsonl(sessionId: string, cwd: string, lines: unknown[] = []): string {
  const dir = defaultSessionDirectory(cwd, process.env.PI_CODING_AGENT_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  const header = { type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' }
  writeFileSync(path, [header, ...lines].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  return path
}

function connectApp(
  store: SessionStore,
  onUpdate?: (update: any) => void,
  onAgent?: (agent: PiAcpAgent | null) => void
) {
  const conn = client({ name: 'pi-acp-1b-tests' })
    .onNotification(methods.client.session.update, ctx => {
      onUpdate?.(ctx.params)
    })
    .connect(createPiAcpAgentApp({ store, onAgent }))
  connection = conn
  return conn
}

test('PR 1B: session/set_title validates inputs and returns -32002 with data.sessionId for unknown sessions', async () => {
  const store = new SessionStore(storePath)
  const conn = connectApp(store)
  await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

  // Invalid titles -> -32602
  for (const badTitle of ['', '   ', '\n\t\x00', null as unknown as string, 42 as unknown as string]) {
    await assert.rejects(
      () => conn.agent.request(methods.agent.session.setTitle, { sessionId: 's1', title: badTitle }),
      (err: unknown) => (err as RequestError).code === -32602
    )
  }

  // Unknown session -> -32002 with data.sessionId
  await assert.rejects(
    () => conn.agent.request(methods.agent.session.setTitle, { sessionId: 'does-not-exist', title: 'Valid Title' }),
    (err: unknown) => {
      const reqErr = err as RequestError
      return (
        reqErr.code === -32002 && (reqErr.data as { sessionId?: string } | undefined)?.sessionId === 'does-not-exist'
      )
    }
  )
})

test('PR 1B: session/set_title renames live session (no updatedAt bump, fenced against auto-title & stale echo) and survives mirror failure', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const updates: any[] = []
  const sessionFile = join(defaultSessionDirectory(testCwd, process.env.PI_CODING_AGENT_DIR), 'live-1.jsonl')
  const proc = new FakePiRpcProcess() as any
  proc.state = { sessionId: 'live-1', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }
  const mirroredNames: string[] = []
  let failMirror = false
  proc.setSessionName = async (name: string) => {
    if (failMirror) throw new Error('pi mirror failed')
    mirroredNames.push(name)
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store, u => updates.push(u))
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    // Empty new session (JSONL not even written yet!) can still be renamed.
    const created = await conn.agent.request(methods.agent.session.new, { cwd: testCwd, mcpServers: [] })
    assert.equal(created.sessionId, 'live-1')

    const res = await conn.agent.request(methods.agent.session.setTitle, {
      sessionId: 'live-1',
      title: '  First\n\tTitle  '
    })
    assert.deepEqual(res, { title: 'First Title' })
    assert.equal(store.get('live-1')?.explicitTitle, 'First Title')
    assert.deepEqual(mirroredNames, ['First Title'])

    const infoUpdate = updates.find(u => u.update?.sessionUpdate === 'session_info_update' && 'title' in u.update)
    assert.equal(infoUpdate?.update?.title, 'First Title')
    assert.equal(infoUpdate?.update?.updatedAt, undefined, 'rename must not bump updatedAt')

    // Generated title widget arriving later must never replace the explicit title.
    proc.emit({
      type: 'extension_ui_request',
      id: 'w1',
      method: 'setWidget',
      widgetKey: TITLE_WIDGET,
      widgetLines: encodeTitleWidget('Auto Generated Title')
    })
    await tick()
    const titles = updates
      .filter(u => u.update?.sessionUpdate === 'session_info_update' && 'title' in u.update)
      .map(u => u.update.title)
    assert.deepEqual(titles, ['First Title'])

    // Native mirror failure must NOT fail session/set_title or roll back the committed ACP overlay.
    failMirror = true
    const res2 = await conn.agent.request(methods.agent.session.setTitle, {
      sessionId: 'live-1',
      title: 'Second Title'
    })
    assert.deepEqual(res2, { title: 'Second Title' })
    assert.equal(store.get('live-1')?.explicitTitle, 'Second Title')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: session/set_title renames closed CLI-discovered session without spawning Pi or editing JSONL, survives restart, and mirrors on attach', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  const spawnedProcs: any[] = []

  const sessionFile = writeSessionJsonl('cli-closed-1', testCwd, [
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:01:00.000Z',
      message: { role: 'user', content: 'original msg' }
    }
  ])
  const jsonlBefore = readFileSync(sessionFile, 'utf8')

  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    const proc = new FakePiRpcProcess() as any
    proc.state = {
      sessionId: 'cli-closed-1',
      sessionFile,
      sessionName: undefined,
      model: { provider: 'test', id: 'm1' },
      thinkingLevel: 'off'
    }
    proc.mirrored = [] as string[]
    proc.setSessionName = async (name: string) => {
      proc.mirrored.push(name)
    }
    spawnedProcs.push(proc)
    return proc
  }

  try {
    // First adapter instance: rename closed unmapped CLI session.
    const store1 = new SessionStore(storePath)
    const conn1 = connectApp(store1)
    await conn1.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    const renamed = await conn1.agent.request(methods.agent.session.setTitle, {
      sessionId: 'cli-closed-1',
      title: 'Closed CLI Session'
    })
    assert.deepEqual(renamed, { title: 'Closed CLI Session' })
    assert.equal(spawnCount, 0, 'closed rename must NEVER spawn a Pi writer')
    assert.equal(readFileSync(sessionFile, 'utf8'), jsonlBefore, 'adapter must NEVER append Pi JSONL directly')

    const listed1 = await conn1.agent.request(methods.agent.session.list, { cwd: testCwd })
    assert.equal(listed1.sessions[0]?.title, 'Closed CLI Session')
    assert.equal(listed1.sessions[0]?.updatedAt, '2026-01-01T00:01:00.000Z', 'message timestamp preserved')
    conn1.close()

    // Second adapter instance (simulating restart): title persists, and attaching seeds fence + mirrors to Pi.
    const store2 = new SessionStore(storePath)
    const updates2: any[] = []
    const conn2 = connectApp(store2, u => updates2.push(u))
    await conn2.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    const listed2 = await conn2.agent.request(methods.agent.session.list, { cwd: testCwd })
    assert.equal(listed2.sessions[0]?.title, 'Closed CLI Session')

    await conn2.agent.request(methods.agent.session.resume, {
      sessionId: 'cli-closed-1',
      cwd: testCwd,
      mcpServers: []
    })
    assert.equal(spawnCount, 1)
    assert.deepEqual(spawnedProcs[0].mirrored, ['Closed CLI Session'], 'attach mirrors explicit title onto owned Pi')

    // Auto-title widget emitted after restore must be fenced out by the seeded explicit title.
    spawnedProcs[0].emit({
      type: 'extension_ui_request',
      id: 'w2',
      method: 'setWidget',
      widgetKey: TITLE_WIDGET,
      widgetLines: encodeTitleWidget('Should Not Override')
    })
    await tick()
    assert.equal(
      updates2.some(
        u => u.update?.sessionUpdate === 'session_info_update' && u.update?.title === 'Should Not Override'
      ),
      false
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: session/set_title propagates storage I/O failures as -32603 without mutating live session', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const updates: any[] = []
  const sessionFile = writeSessionJsonl('s-io-fail', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = { sessionId: 's-io-fail', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }
  const mirrored: string[] = []
  proc.setSessionName = async (name: string) => mirrored.push(name)
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store, u => updates.push(u))
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, { sessionId: 's-io-fail', cwd: testCwd, mcpServers: [] })

    // Inject storage I/O failure on upsert.
    store.upsert = () => {
      throw new Error('ENOSPC: disk full')
    }

    await assert.rejects(
      () => conn.agent.request(methods.agent.session.setTitle, { sessionId: 's-io-fail', title: 'Will Fail' }),
      (err: unknown) => (err as RequestError).code === -32603
    )
    assert.deepEqual(mirrored, [], 'must not mirror to Pi when overlay persistence failed')
    assert.equal(
      updates.some(u => u.update?.sessionUpdate === 'session_info_update' && u.update?.title === 'Will Fail'),
      false
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: session/status is strictly read-only across open, saved, CLI-discovered, unavailable, unknown, and corrupt/IO-error cases', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  let rpcCount = 0
  const store = new SessionStore(storePath)

  // Spy on every mutating store method.
  let upsertCalls = 0
  let deleteCalls = 0
  const origUpsert = store.upsert.bind(store)
  const origDelete = store.delete.bind(store)
  store.upsert = (...args: Parameters<SessionStore['upsert']>) => {
    upsertCalls += 1
    return origUpsert(...args)
  }
  store.delete = (...args: Parameters<SessionStore['delete']>) => {
    deleteCalls += 1
    return origDelete(...args)
  }

  const savedFile = writeSessionJsonl('cli-saved', testCwd)
  const openFile = join(defaultSessionDirectory(testCwd, process.env.PI_CODING_AGENT_DIR), 'live-open.jsonl')
  const proc = new FakePiRpcProcess() as any
  proc.state = {
    sessionId: 'live-open',
    sessionFile: openFile,
    model: { provider: 'test', id: 'm1' },
    thinkingLevel: 'off'
  }
  const origGetState = proc.getState.bind(proc)
  proc.getState = async () => {
    rpcCount += 1
    return origGetState()
  }
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return proc
  }

  try {
    let agentRef: PiAcpAgent | null = null
    const conn = connectApp(store, undefined, agent => {
      agentRef = agent
    })
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    // Create an active open session (even with no JSONL file written yet).
    await conn.agent.request(methods.agent.session.new, { cwd: testCwd, mcpServers: [] })
    const baselineSpawns = spawnCount
    const baselineUpserts = upsertCalls
    const baselineDeletes = deleteCalls
    const baselineRpcs = rpcCount

    const manager = (agentRef as any).sessions
    let retireCalls = 0
    const origRetire = manager.retire.bind(manager)
    manager.retire = (...args: unknown[]) => {
      retireCalls += 1
      return origRetire(...args)
    }

    // 1) Actively open session -> 'open'
    assert.deepEqual(await conn.agent.request(methods.agent.session.status, { sessionId: 'live-open' }), {
      status: 'open'
    })

    // 2) Unmapped CLI-discovered saved session -> 'saved' (NO store.upsert!)
    assert.deepEqual(await conn.agent.request(methods.agent.session.status, { sessionId: 'cli-saved' }), {
      status: 'saved'
    })

    // 3) Unknown session -> -32002 with data.sessionId
    await assert.rejects(
      () => conn.agent.request(methods.agent.session.status, { sessionId: 'unknown-xyz' }),
      (err: unknown) =>
        (err as RequestError).code === -32002 &&
        ((err as RequestError).data as { sessionId?: string } | undefined)?.sessionId === 'unknown-xyz'
    )

    // 4) Unavailable child still sitting in SessionManager must NOT be retired by status!
    proc.emitTermination({ expected: false, code: 1 })
    await tick()
    // live-open has no JSONL file on disk, so after child death status -> -32002, with zero retire calls!
    await assert.rejects(
      () => conn.agent.request(methods.agent.session.status, { sessionId: 'live-open' }),
      (err: unknown) => (err as RequestError).code === -32002
    )
    assert.equal(retireCalls, 0, 'session/status must use pure peek and never call SessionManager.retire')
    assert.equal(spawnCount, baselineSpawns, 'session/status must never spawn Pi')
    assert.equal(upsertCalls, baselineUpserts, 'session/status must never repair/upsert the store')
    assert.equal(deleteCalls, baselineDeletes, 'session/status must never tombstone the store')
    assert.equal(rpcCount, baselineRpcs, 'session/status must never send Pi RPCs')

    // 5) Genuine store corruption propagates as -32603 (never silently returns 'saved' or 'not found').
    writeFileSync(storePath, '{corrupt json', 'utf8')
    await assert.rejects(
      () => conn.agent.request(methods.agent.session.status, { sessionId: 'cli-saved' }),
      (err: unknown) => (err as RequestError).code === -32603
    )

    // 6) Unreadable mapped file (EACCES) propagates as -32603 when non-root on POSIX.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const store2 = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pi-acp-1b-perm-')), 'map.json'))
      const unreadable = writeSessionJsonl('unreadable-1', testCwd)
      store2.upsert({ sessionId: 'unreadable-1', cwd: testCwd, sessionFile: unreadable })
      chmodSync(unreadable, 0o000)
      try {
        const conn2 = connectApp(store2)
        await conn2.agent.request(methods.agent.initialize, { protocolVersion: 1 })
        await assert.rejects(
          () => conn2.agent.request(methods.agent.session.status, { sessionId: 'unreadable-1' }),
          (err: unknown) => (err as RequestError).code === -32603
        )
      } finally {
        chmodSync(unreadable, 0o600)
      }
    }
    void savedFile
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: synchronous Pi session_info_changed echoes during /name and closed-rename restore never bump updatedAt or emit pre-response updates', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const updates: any[] = []
  const sessionFile = writeSessionJsonl('sync-echo-1', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = {
    sessionId: 'sync-echo-1',
    sessionFile,
    sessionName: undefined,
    model: { provider: 'test', id: 'm1' },
    thinkingLevel: 'off'
  }
  proc.setSessionName = async (name: string) => {
    // Real Pi emits session_info_changed synchronously before RPC response resolves.
    proc.emit({ type: 'session_info_changed', name })
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store, u => updates.push(u))
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    // 1) Rename closed session, then restore: synchronous mirror echo must NOT emit a pre-response session_info_update.
    await conn.agent.request(methods.agent.session.setTitle, { sessionId: 'sync-echo-1', title: 'Closed Explicit' })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'sync-echo-1',
      cwd: testCwd,
      mcpServers: []
    })
    await tick()
    assert.deepEqual(
      updates.filter(u => u.update?.sessionUpdate === 'session_info_update' && 'title' in u.update),
      [],
      'restore mirror echo must not emit a pre-response session_info_update'
    )

    // 2) Live /name with synchronous Pi echo must emit ONE session_info_update with NO updatedAt.
    const promptRes = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: 'sync-echo-1',
      prompt: [{ type: 'text', text: '/name Renamed Via Slash' }]
    })
    assert.equal(promptRes.stopReason, 'end_turn')
    await tick()

    const titleUpdates = updates
      .filter(u => u.update?.sessionUpdate === 'session_info_update' && 'title' in u.update)
      .map(u => u.update)
    assert.equal(titleUpdates.length, 1)
    assert.equal(titleUpdates[0]?.title, 'Renamed Via Slash')
    assert.equal(titleUpdates[0]?.updatedAt, undefined, '/name must not bump updatedAt via synchronous Pi echo')
    assert.equal(store.get('sync-echo-1')?.explicitTitle, 'Renamed Via Slash')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: /name fails closed on overlay storage error without reporting success or mutating Pi', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const updates: any[] = []
  const sessionFile = writeSessionJsonl('slash-io-fail', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = { sessionId: 'slash-io-fail', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }
  const setCalls: string[] = []
  proc.setSessionName = async (name: string) => {
    setCalls.push(name)
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store, u => updates.push(u))
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'slash-io-fail',
      cwd: testCwd,
      mcpServers: []
    })

    // Inject overlay persistence failure.
    store.upsert = () => {
      throw new Error('ENOSPC: disk full')
    }

    await assert.rejects(
      () =>
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: 'slash-io-fail',
          prompt: [{ type: 'text', text: '/name Broken Persist' }]
        }),
      (err: unknown) => (err as RequestError).code === -32603
    )
    await tick()
    assert.deepEqual(setCalls, [], 'must not call Pi setSessionName when durable overlay commit fails')
    assert.equal(
      updates.some(
        u =>
          u.update?.sessionUpdate === 'agent_message_chunk' &&
          String(u.update?.content?.text ?? '').includes('Session name set')
      ),
      false,
      'must not report Session name set on storage error'
    )
    assert.equal(
      updates.some(u => u.update?.sessionUpdate === 'session_info_update' && 'title' in u.update),
      false
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: session/set_title and /name fail closed with -32002 when tombstoned concurrently, and /name rollback is revision-fenced', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const sessionFile = writeSessionJsonl('tomb-race', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = { sessionId: 'tomb-race', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }
  let onSetSessionName: ((name: string) => Promise<void>) | undefined
  proc.setSessionName = async (name: string) => {
    if (onSetSessionName) await onSetSessionName(name)
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store)
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'tomb-race',
      cwd: testCwd,
      mcpServers: []
    })

    // Seed initial explicit title.
    await conn.agent.request(methods.agent.session.setTitle, { sessionId: 'tomb-race', title: 'Initial' })
    assert.equal(store.get('tomb-race')?.explicitTitle, 'Initial')

    // 1) /name Pi rejection rolls back to previous title when revision still matches.
    onSetSessionName = async () => {
      throw new Error('pi rejected rename')
    }
    const res1 = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: 'tomb-race',
      prompt: [{ type: 'text', text: '/name Rejected Attempt' }]
    })
    assert.equal(res1.stopReason, 'end_turn')
    assert.equal(store.get('tomb-race')?.explicitTitle, 'Initial', 'matching-revision rollback restores previous title')

    // 2) /name Pi rejection must NOT clobber a concurrent newer title written by another writer.
    onSetSessionName = async () => {
      store.upsert({ sessionId: 'tomb-race', cwd: testCwd, sessionFile, explicitTitle: 'Newer Concurrent Title' })
      throw new Error('pi rejected older rename')
    }
    const res2 = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: 'tomb-race',
      prompt: [{ type: 'text', text: '/name Stale Attempt' }]
    })
    assert.equal(res2.stopReason, 'end_turn')
    assert.equal(
      store.get('tomb-race')?.explicitTitle,
      'Newer Concurrent Title',
      'revision-fenced rollback must not clobber newer title'
    )

    // 3) /name Pi rejection must NOT recreate a sidecar behind a tombstone written concurrently.
    onSetSessionName = async () => {
      store.delete('tomb-race')
      throw new Error('pi rejected after tombstone')
    }
    const res3 = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: 'tomb-race',
      prompt: [{ type: 'text', text: '/name After Delete' }]
    })
    assert.equal(res3.stopReason, 'end_turn')
    assert.equal(store.get('tomb-race'), null, 'rollback behind tombstone must not recreate record/sidecar')

    // 4) Subsequent /name and session/set_title on the tombstoned session fail closed with -32002.
    onSetSessionName = undefined
    await assert.rejects(
      () =>
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: 'tomb-race',
          prompt: [{ type: 'text', text: '/name Should Fail' }]
        }),
      (err: unknown) => (err as RequestError).code === -32002
    )
    await assert.rejects(
      () => conn.agent.request(methods.agent.session.setTitle, { sessionId: 'tomb-race', title: 'Should Fail' }),
      (err: unknown) => (err as RequestError).code === -32002
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: /name racing a queued session/set_title rolls back to the queued title when Pi rejects /name', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const sessionFile = writeSessionJsonl('queue-race', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = { sessionId: 'queue-race', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }

  let heldStarted!: () => void
  const onHeldStarted = new Promise<void>(resolve => {
    heldStarted = resolve
  })
  let releaseHeld!: () => void
  const heldGate = new Promise<void>(resolve => {
    releaseHeld = resolve
  })
  proc.setSessionName = async (name: string) => {
    if (name === 'Held Title') {
      heldStarted()
      await heldGate
      return
    }
    if (name === 'Rejected') {
      throw new Error('pi rejected /name')
    }
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    const conn = connectApp(store)
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'queue-race',
      cwd: testCwd,
      mcpServers: []
    })

    // 1) Start first session/set_title and hold it inside Pi mirror.
    const firstRename = conn.agent.request(methods.agent.session.setTitle, {
      sessionId: 'queue-race',
      title: 'Held Title'
    })
    await onHeldStarted

    // 2) Queue a second session/set_title behind the held one.
    const queuedRename = conn.agent.request(methods.agent.session.setTitle, {
      sessionId: 'queue-race',
      title: 'Queued Title'
    })
    // 3) Start /name Rejected while the second session/set_title is still queued.
    const slashRename = conn.agent.request(methods.agent.session.prompt, {
      sessionId: 'queue-race',
      prompt: [{ type: 'text', text: '/name Rejected' }]
    })
    await tick()

    releaseHeld()
    assert.deepEqual(await firstRename, { title: 'Held Title' })
    assert.deepEqual(await queuedRename, { title: 'Queued Title' })
    assert.equal((await slashRename).stopReason, 'end_turn')

    assert.equal(
      store.get('queue-race')?.explicitTitle,
      'Queued Title',
      '/name rejection must roll back to the queued session/set_title and never leave Rejected on disk'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: corrupt .title sidecar appearing before post-upsert read in restoreFromStore closes session and disposes Pi child', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const sessionFile = writeSessionJsonl('corrupt-restore', testCwd)
  store.upsert({ sessionId: 'corrupt-restore', cwd: testCwd, sessionFile })

  const proc = new FakePiRpcProcess() as any
  proc.terminateOnDispose = true
  proc.state = {
    sessionId: 'corrupt-restore',
    sessionFile,
    model: { provider: 'test', id: 'm1' },
    thinkingLevel: 'off'
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  // Inject a corrupt sidecar right after restoreFromStore's store.upsert() succeeds,
  // before the post-upsert store.get(sessionId)?.explicitTitle read runs.
  const origUpsert = store.upsert.bind(store)
  store.upsert = entry => {
    const rev = origUpsert(entry)
    const sidecarPath = join(`${storePath}.d`, `${Buffer.from('corrupt-restore', 'utf-8').toString('base64url')}.title`)
    writeFileSync(sidecarPath, '{corrupt sidecar', 'utf8')
    return rev
  }

  try {
    let agentRef: PiAcpAgent | null = null
    const conn = connectApp(store, undefined, agent => {
      agentRef = agent
    })
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

    await assert.rejects(
      () =>
        conn.agent.request(methods.agent.session.resume, {
          sessionId: 'corrupt-restore',
          cwd: testCwd,
          mcpServers: []
        }),
      (err: unknown) => (err as RequestError).code === -32603
    )

    assert.equal(proc.disposed, true, 'spawned Pi child must be disposed on post-upsert corrupt sidecar read')
    assert.equal(
      (agentRef as any).sessions.peek('corrupt-restore'),
      undefined,
      'failed restore must not leak a live session in SessionManager'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: cancelled /name waiting on titleMutationQueues never writes sidecar or calls Pi setSessionName', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const sessionFile = writeSessionJsonl('cancel-title-queue', testCwd)
  const proc = new FakePiRpcProcess() as any
  proc.state = {
    sessionId: 'cancel-title-queue',
    sessionFile,
    model: { provider: 'test', id: 'm1' },
    thinkingLevel: 'off'
  }
  const mirrored: string[] = []
  proc.setSessionName = async (name: string) => {
    mirrored.push(name)
  }
  ;(PiRpcProcess as any).spawn = async () => proc

  let infoBlocked!: () => void
  const onInfoBlocked = new Promise<void>(resolve => {
    infoBlocked = resolve
  })
  let releaseInfo!: () => void
  const infoGate = new Promise<void>(resolve => {
    releaseInfo = resolve
  })

  try {
    let agentRef: PiAcpAgent | null = null
    const conn = connectApp(store, undefined, agent => {
      agentRef = agent
    })

    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'cancel-title-queue',
      cwd: testCwd,
      mcpServers: []
    })

    // Hold an earlier session/set_title inside its blocked client session_info_update delivery.
    const agentConn = (agentRef as unknown as { conn: { sessionUpdate: (p: any) => Promise<void> } }).conn
    const origSessionUpdate = agentConn.sessionUpdate.bind(agentConn)
    agentConn.sessionUpdate = async notification => {
      if (notification.update.sessionUpdate === 'session_info_update' && 'title' in notification.update) {
        infoBlocked()
        await infoGate
      }
      await origSessionUpdate(notification)
    }

    const heldRename = conn.agent.request(methods.agent.session.setTitle, {
      sessionId: 'cancel-title-queue',
      title: 'Saved Title'
    })
    await onInfoBlocked

    // Start /name while titleMutationQueues is held, then cancel it before the gate opens.
    const controller = new AbortController()
    const slashPromise = agentRef!.prompt(
      { sessionId: 'cancel-title-queue', prompt: [{ type: 'text', text: '/name Cancelled Name' }] },
      controller.signal
    )
    await tick()
    controller.abort()
    await tick()

    releaseInfo()
    assert.deepEqual(await heldRename, { title: 'Saved Title' })
    assert.equal((await slashPromise).stopReason, 'cancelled')
    await tick()

    assert.equal(
      store.get('cancel-title-queue')?.explicitTitle,
      'Saved Title',
      'cancelled /name queued on titleMutationQueues must not overwrite saved title on disk'
    )
    assert.equal(mirrored.includes('Cancelled Name'), false, 'cancelled /name must never call Pi setSessionName')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1B: restoreFromStore does not resurrect an explicit title removed or rolled back during spawn', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const store = new SessionStore(storePath)
  const sessionFile = writeSessionJsonl('rollback-during-spawn', testCwd)
  const rev = store.upsert({
    sessionId: 'rollback-during-spawn',
    cwd: testCwd,
    sessionFile,
    explicitTitle: 'Rolled Back Title'
  })
  assert.ok(rev)

  const mirrored: string[] = []
  const updates: any[] = []
  const proc = new FakePiRpcProcess() as any
  proc.state = {
    sessionId: 'rollback-during-spawn',
    sessionFile,
    sessionName: undefined,
    model: { provider: 'test', id: 'm1' },
    thinkingLevel: 'off'
  }
  proc.setSessionName = async (name: string) => {
    mirrored.push(name)
  }
  ;(PiRpcProcess as any).spawn = async () => {
    // Roll back the explicit title while Pi is spawning.
    assert.equal(store.rollbackExplicitTitle('rollback-during-spawn', rev, null), true)
    return proc
  }

  try {
    const conn = connectApp(store, u => updates.push(u))
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
    await conn.agent.request(methods.agent.session.resume, {
      sessionId: 'rollback-during-spawn',
      cwd: testCwd,
      mcpServers: []
    })
    await tick()

    assert.deepEqual(mirrored, [], 'rolled-back title must not be mirrored onto Pi during restore')

    // Because no explicit title was seeded, a subsequent auto-title widget is allowed through.
    proc.emit({
      type: 'extension_ui_request',
      id: 'w-auto',
      method: 'setWidget',
      widgetKey: TITLE_WIDGET,
      widgetLines: encodeTitleWidget('Fresh Generated Title')
    })
    await tick()
    assert.ok(
      updates.some(
        u => u.update?.sessionUpdate === 'session_info_update' && u.update?.title === 'Fresh Generated Title'
      ),
      'session must not be fenced by a rolled-back explicit title'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
