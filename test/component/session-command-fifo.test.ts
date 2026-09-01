import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Adapter-handled slash commands share the session FIFO with ordinary prompts:
// they wait for an active turn, hold later prompts back while they run, and a
// session/cancel settles them promptly.
//
// Real pi (0.84.2) does not cancel an in-flight manual RPC: `abort` stops an
// agent run and leaves compaction/export running to completion. Cancellation
// therefore fails closed by quarantining the channel, and these tests model pi
// that way -- `proc.abort()` never settles a pending request here either.

class FakeSessions {
  readonly evicted: string[] = []

  constructor(private readonly session: PiAcpSession) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
  evictIfCurrent(sessionId: string, expected: PiAcpSession) {
    if (expected !== this.session) return false
    this.evicted.push(sessionId)
    return true
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Holds every session update back until its gate settles (a slow client). */
class GatedConnection extends FakeAgentSideConnection {
  private gate: Promise<void> | null = null

  gateUpdates(gate: Promise<void>): void {
    this.gate = gate
  }

  async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    if (this.gate) await this.gate
    return super.sessionUpdate(msg)
  }
}

function makeAgent(proc: FakePiRpcProcess, conn: FakeAgentSideConnection = new FakeAgentSideConnection()) {
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as never,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new FakeSessions(session)
  ;(agent as any).sessions = sessions as any
  return { agent, conn, session, sessions }
}

function promptParams(text: string) {
  return { sessionId: 's1', prompt: [{ type: 'text', text }] } as any
}

function queueStates(conn: FakeAgentSideConnection): Array<{ queueDepth?: number; running?: boolean }> {
  return conn.updates.flatMap(update => {
    if (update.update.sessionUpdate !== 'session_info_update') return []
    const meta = (update.update as { _meta?: { piAcp?: { queueDepth?: number; running?: boolean } } })._meta?.piAcp
    return meta && typeof meta.running === 'boolean' ? [meta] : []
  })
}

function agentMessageTexts(conn: FakeAgentSideConnection): string[] {
  return conn.updates.flatMap(update => {
    if (update.update.sessionUpdate !== 'agent_message_chunk') return []
    const content = (update.update as { content?: { type?: unknown; text?: unknown } }).content
    return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []
  })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('PiAcpAgent: an adapter command queues behind the active prompt instead of racing it', async () => {
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    names.push(name)
  }
  const { agent, conn } = makeAgent(proc)

  const running = agent.prompt(promptParams('hello'))
  await tick()
  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['hello']
  )

  const named = agent.prompt(promptParams('/name Later'))
  await tick()
  assert.deepEqual(names, [], 'the command must not run while a prompt owns the session')

  proc.emit({ type: 'agent_settled' })

  assert.equal((await running).stopReason, 'end_turn')
  assert.equal((await named).stopReason, 'end_turn')
  assert.deepEqual(names, ['Later'], 'the command runs once the prompt settled')
  assert.equal(proc.prompts.length, 1, 'an adapter command never reaches pi as a prompt')

  const texts = agentMessageTexts(conn)
  const queuedIndex = texts.findIndex(text => text.startsWith('Queued message'))
  const appliedIndex = texts.findIndex(text => text.includes('Session name set: Later'))
  assert.ok(queuedIndex >= 0, 'the queued command is announced like a queued prompt')
  assert.ok(appliedIndex > queuedIndex, 'the command result is delivered after its queue notice')
})

test('PiAcpAgent: prompt usage is captured before the FIFO admits the next prompt', async () => {
  const proc = new FakePiRpcProcess() as any
  const usageStarted = deferred<void>()
  const usageResult = deferred<unknown>()
  proc.getSessionStats = () => {
    usageStarted.resolve()
    return usageResult.promise
  }
  const { agent } = makeAgent(proc)

  const first = agent.prompt(promptParams('first'))
  await tick()
  const second = agent.prompt(promptParams('second'))
  proc.emit({ type: 'agent_settled' })
  await usageStarted.promise
  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['first'],
    'the next prompt stays queued while usage is captured'
  )

  usageResult.resolve({ tokens: { input: 1, output: 2, total: 3 } })
  assert.equal((await first).usage?.totalTokens, 3)
  await tick()
  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['first', 'second']
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal((await second).stopReason, 'end_turn')
})

test('PiAcpAgent: command usage is captured before the FIFO admits the next prompt', async () => {
  const proc = new FakePiRpcProcess() as any
  const usageStarted = deferred<void>()
  const usageResult = deferred<unknown>()
  proc.compact = async () => ({ tokensBefore: 10 })
  proc.getSessionStats = () => {
    usageStarted.resolve()
    return usageResult.promise
  }
  const { agent } = makeAgent(proc)

  const compacting = agent.prompt(promptParams('/compact'))
  await usageStarted.promise
  const queued = agent.prompt(promptParams('after command'))
  await tick()
  assert.equal(proc.prompts.length, 0, 'usage capture keeps the command FIFO slot')

  usageResult.resolve({ tokens: { input: 4, output: 5, total: 9 } })
  assert.equal((await compacting).usage?.totalTokens, 9)
  await tick()
  assert.equal(proc.prompts[0]?.message, 'after command')
  proc.emit({ type: 'agent_settled' })
  assert.equal((await queued).stopReason, 'end_turn')
})

test('PiAcpAgent: a prompt arriving during an adapter command waits for it', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactStarted = deferred<void>()
  const compactResult = deferred<unknown>()
  proc.compact = () => {
    compactStarted.resolve()
    return proc.pendingRequest(compactResult.promise)
  }
  const { agent } = makeAgent(proc)

  const compacting = agent.prompt(promptParams('/compact'))
  await compactStarted.promise

  const queuedPrompt = agent.prompt(promptParams('hello'))
  await tick()
  assert.equal(proc.prompts.length, 0, 'a prompt must not reach pi while an adapter command holds the FIFO')

  compactResult.resolve({ tokensBefore: 10 })
  assert.equal((await compacting).stopReason, 'end_turn')
  await tick()

  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['hello'],
    'the queued prompt starts only after the command finished'
  )

  proc.emit({ type: 'agent_settled' })
  assert.equal((await queuedPrompt).stopReason, 'end_turn')
})

test('PiAcpAgent: cancelling a command blocked on pi quarantines the channel and settles as cancelled', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactStarted = deferred<void>()
  // Never settled by the test: only quarantining the channel can end this RPC,
  // exactly like a real manual compaction that pi refuses to abort.
  const compactResult = deferred<unknown>()
  proc.compact = () => {
    compactStarted.resolve()
    return proc.pendingRequest(compactResult.promise)
  }
  const { agent, conn, session, sessions } = makeAgent(proc)

  const compacting = agent.prompt(promptParams('/compact'))
  await compactStarted.promise

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal(proc.abortCount, 0, 'abort cannot settle a manual RPC, so cancellation does not issue one')
  assert.equal(proc.disposeCount, 1, 'the channel is quarantined so the pending RPC rejects promptly')
  assert.equal((await compacting).stopReason, 'cancelled')
  assert.equal(session.isUnavailable(), true, 'the quarantined session is unavailable and must be restored later')
  assert.deepEqual(sessions.evicted, ['s1'], 'the agent evicts it so a later request restores the session')
  assert.deepEqual(
    agentMessageTexts(conn).filter(text => text.includes('Compaction completed')),
    [],
    'a cancelled command publishes no completion output'
  )
})

test('PiAcpAgent: cancelling a command with no pending pi RPC leaves the channel alone', async () => {
  const proc = new FakePiRpcProcess() as any
  const rpcSettled = deferred<unknown>()
  const localWork = deferred<void>()
  let started = false
  proc.compact = async () => {
    started = true
    // The pi RPC completes first; the command is still doing adapter-local
    // work (formatting/emitting its result) when cancellation arrives.
    const result = await proc.pendingRequest(rpcSettled.promise)
    await localWork.promise
    return result
  }
  const { agent } = makeAgent(proc)

  const compacting = agent.prompt(promptParams('/compact'))
  await tick()
  assert.equal(started, true)

  rpcSettled.resolve({ tokensBefore: 10 })
  await tick()
  assert.equal(proc.hasPendingRequests(), false)

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal(proc.abortCount, 0, 'no pi work is in flight, so unrelated autonomous work must not be aborted')
  assert.equal(proc.disposeCount, 0, 'a healthy channel is never quarantined for a command with no pending RPC')

  localWork.resolve()
  assert.equal((await compacting).stopReason, 'cancelled', 'the ACP request still settles as cancelled')
  assert.equal(proc.disposeCount, 0, 'the session stays usable for the next request')
})

test('PiAcpAgent: a settled command publishes terminal idle queue metadata', async () => {
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    names.push(name)
  }
  const { agent, conn } = makeAgent(proc)

  const running = agent.prompt(promptParams('hello'))
  await tick()
  const named = agent.prompt(promptParams('/name Later'))
  await tick()

  proc.emit({ type: 'agent_settled' })
  await running
  await named
  await tick()

  const queueMeta = conn.updates.flatMap(update => {
    if (update.update.sessionUpdate !== 'session_info_update') return []
    const meta = (update.update as { _meta?: { piAcp?: { queueDepth?: number; running?: boolean } } })._meta?.piAcp
    return meta && typeof meta.running === 'boolean' ? [meta] : []
  })

  assert.ok(queueMeta.length > 0, 'queue metadata is published')
  assert.deepEqual(
    queueMeta[queueMeta.length - 1],
    { queueDepth: 0, running: false },
    'the last snapshot after a queued command settles must not stay running:true'
  )
})

test('PiAcpSession: shutdown settles a command blocked on pi as cancelled, not as a failure', async () => {
  const proc = new FakePiRpcProcess() as any
  const started = deferred<void>()
  // Only disposal can end this RPC, like a real manual compaction.
  const neverSettles = deferred<unknown>()
  const { session } = makeAgent(proc)

  const command = session.runCommand(() => {
    started.resolve()
    return proc.pendingRequest(neverSettles.promise)
  })
  await started.promise

  // Mirrors PiAcpAgent.closeSessionResources: shutdown, then dispose.
  const shutdown = session.shutdown()
  session.dispose()
  await shutdown

  assert.equal(await command, null, 'the command reports cancellation rather than the induced RPC rejection')
})

test('PiAcpAgent: cancelling clears commands queued behind the active prompt', async () => {
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    names.push(name)
  }
  const { agent } = makeAgent(proc)

  const running = agent.prompt(promptParams('hello'))
  await tick()
  const named = agent.prompt(promptParams('/name Later'))
  await tick()

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await named).stopReason, 'cancelled')
  assert.deepEqual(names, [], 'a cleared command never runs')

  // The aborted prompt settles once pi acknowledges the abort.
  proc.emit({ type: 'agent_settled' })
  assert.equal((await running).stopReason, 'cancelled')
  assert.deepEqual(names, [], 'the cleared command stays cleared after the prompt settles')
})

test('PiAcpAgent: cancelling an in-flight /name publishes no induced failure', async () => {
  const proc = new FakePiRpcProcess() as any
  const started = deferred<void>()
  // Only quarantining the channel can end this RPC, like a real pi command.
  const neverSettles = deferred<void>()
  proc.setSessionName = (name: string) => {
    started.resolve()
    void name
    return proc.pendingRequest(neverSettles.promise)
  }
  const { agent, conn, session } = makeAgent(proc)

  const naming = agent.prompt(promptParams('/name Later'))
  await started.promise

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await naming).stopReason, 'cancelled')
  assert.equal(proc.disposeCount, 1, 'the pending RPC is ended by quarantining the channel')
  await tick()

  const texts = agentMessageTexts(conn)
  assert.deepEqual(
    texts.filter(text => text.startsWith('Failed to set session name')),
    [],
    'the cancellation-induced RPC rejection must not be reported as a command failure'
  )
  assert.deepEqual(
    texts.filter(text => text.includes('Session name set')),
    [],
    'a cancelled command publishes no success either'
  )
  assert.deepEqual(
    conn.updates.filter(update => 'title' in update.update),
    [],
    'a cancelled /name does not rename the session on the client'
  )

  // The FIFO slot is released and the client's last queue snapshot is honest.
  assert.equal(session.isUnavailable(), true)
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })
})

test('PiAcpAgent: cancelling an in-flight /export publishes neither a failure nor a link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-export-cancel-'))
  const sessionFile = join(root, 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session"}\n', 'utf-8')

  const proc = new FakePiRpcProcess() as any
  proc.state = { isStreaming: false, sessionFile, messageCount: 2 }
  const started = deferred<void>()
  const neverSettles = deferred<{ path: string }>()
  proc.exportHtml = () => {
    started.resolve()
    return proc.pendingRequest(neverSettles.promise)
  }
  const { agent, conn, session } = makeAgent(proc)

  const exporting = agent.prompt(promptParams('/export'))
  await started.promise

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await exporting).stopReason, 'cancelled')
  assert.equal(proc.disposeCount, 1)
  await tick()

  const texts = agentMessageTexts(conn)
  assert.deepEqual(
    texts.filter(text => text.startsWith('Export failed')),
    [],
    'the cancellation-induced RPC rejection must not be reported as an export failure'
  )
  assert.deepEqual(
    texts.filter(text => text.startsWith('Session exported')),
    [],
    'a cancelled export publishes no success prefix'
  )
  assert.deepEqual(
    conn.updates.filter(update => {
      const content = (update.update as { content?: { type?: string } }).content
      return content?.type === 'resource_link'
    }),
    [],
    'a cancelled export publishes no resource link'
  )

  assert.equal(session.isUnavailable(), true)
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })
})

test('PiAcpSession: a command cancelled before it starts publishes no deferred startup output', async () => {
  const proc = new FakePiRpcProcess() as any
  const { session, conn } = makeAgent(proc)
  session.setStartupInfo('pi v0.0.0 startup banner')

  let ran = false
  // Admission resolves immediately, so the command body only resumes in a
  // later microtask: this cancellation lands inside that window.
  const command = session.runCommand(async () => {
    ran = true
    return 'done'
  })
  await session.cancel()

  assert.equal(await command, null, 'the command settles as cancelled')
  assert.equal(ran, false, 'a cancelled command never runs')
  assert.deepEqual(
    agentMessageTexts(conn).filter(text => text.includes('startup banner')),
    [],
    'the deferred startup banner must not escape for a command that never ran'
  )
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false }, 'the FIFO slot is released')

  // The banner was deferred, not dropped: the next command still flushes it.
  assert.equal(await session.runCommand(async () => 'ok'), 'ok')
  assert.ok(
    agentMessageTexts(conn).some(text => text.includes('startup banner')),
    'a command that actually runs publishes the deferred startup info'
  )
})

test('PiAcpAgent: a /name title queued behind other work is not published after cancellation', async () => {
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    names.push(name)
  }
  const conn = new GatedConnection()
  const { agent, session } = makeAgent(proc, conn)

  const release = deferred<void>()
  conn.gateUpdates(release.promise)

  // Occupy the serialized session-info queue, so the command's own title
  // publication can only run after cancellation already settled.
  const earlier = session.syncSessionInfo('Earlier')
  const naming = agent.prompt(promptParams('/name Later'))
  await tick()
  assert.deepEqual(names, ['Later'], 'the rename reached pi before cancellation')

  const cancelling = agent.cancel({ sessionId: 's1' } as any)
  release.resolve()
  await cancelling
  await earlier

  assert.equal((await naming).stopReason, 'cancelled')
  await tick()

  const titles = conn.updates.filter(update => 'title' in update.update).map(update => (update.update as any).title)
  assert.deepEqual(titles, ['Earlier'], 'the queued title must not publish after its command was cancelled')
})

test('PiAcpAgent: a command cancelled after its pi RPC finished publishes no late success', async () => {
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  const rpcSettled = deferred<void>()
  const localWork = deferred<void>()
  proc.setSessionName = async (name: string) => {
    names.push(name)
    // The pi RPC completes first; the command is still doing adapter-local
    // work (publishing its result) when cancellation arrives.
    await proc.pendingRequest(rpcSettled.promise)
    await localWork.promise
  }
  const { agent, conn, session } = makeAgent(proc)

  const naming = agent.prompt(promptParams('/name Later'))
  await tick()
  rpcSettled.resolve()
  await tick()
  assert.equal(proc.hasPendingRequests(), false)

  await agent.cancel({ sessionId: 's1' } as any)
  localWork.resolve()

  assert.equal((await naming).stopReason, 'cancelled')
  await tick()

  assert.deepEqual(names, ['Later'], 'the write itself had already reached pi')
  assert.deepEqual(
    agentMessageTexts(conn).filter(text => text.includes('Session name set')),
    [],
    'a result computed before cancellation must not be published as a late success'
  )
  assert.deepEqual(
    conn.updates.filter(update => 'title' in update.update),
    [],
    'the client-side rename is skipped too'
  )

  // No pi work was in flight, so the healthy session keeps serving prompts.
  assert.equal(proc.disposeCount, 0)
  assert.equal(session.isUnavailable(), false)
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })

  const next = agent.prompt(promptParams('hello'))
  await tick()
  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['hello'],
    'the FIFO slot was released for the next prompt'
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal((await next).stopReason, 'end_turn')
})
