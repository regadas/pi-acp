import test from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Adapter-handled commands reach pi through manual RPCs that pi will not abort,
// so one must never start while an autonomous extension run owns the event
// stream: the command keeps its FIFO slot (holding later prompts back) until
// that run reaches its authoritative `agent_settled` boundary, and fails closed
// if it never arrives.

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

function makeAgent(proc: FakePiRpcProcess, opts?: { deferredAdmissionTimeoutMs?: number }) {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    ...(opts?.deferredAdmissionTimeoutMs !== undefined
      ? { deferredAdmissionTimeoutMs: opts.deferredAdmissionTimeoutMs }
      : {})
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

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A pi whose compaction RPC is observable and resolves on demand. */
function trackCompaction(proc: any) {
  const calls: Array<string | undefined> = []
  proc.compact = async (customInstructions?: string) => {
    calls.push(customInstructions)
    return { tokensBefore: 10, summary: 'done' }
  }
  return calls
}

test('PiAcpAgent: an adapter command waits for out-of-band pi work and runs at its settlement', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent } = makeAgent(proc, { deferredAdmissionTimeoutMs: 1_000 })

  // An extension started a run this adapter does not own.
  proc.emit({ type: 'agent_start' })

  const compacting = agent.prompt(promptParams('/compact'))
  await tick()
  assert.deepEqual(compactions, [], 'the command must not race the autonomous run')

  proc.emit({ type: 'agent_settled' })

  assert.equal((await compacting).stopReason, 'end_turn')
  assert.deepEqual(compactions, [undefined], 'the command runs once the foreign run settled')
  assert.equal(proc.abortCount, 0, 'the unrelated autonomous run is never aborted')
  assert.equal(proc.disposeCount, 0)
})

test('PiAcpAgent: a settlement admits a parked command exactly once and clears its timeout', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent, session } = makeAgent(proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })
  const compacting = agent.prompt(promptParams('/compact'))
  await tick()

  proc.emit({ type: 'agent_settled' })
  assert.equal((await compacting).stopReason, 'end_turn')

  // Well past the admission timeout: a stale timer must not quarantine the
  // channel or admit a second time.
  await sleep(60)
  assert.deepEqual(compactions, [undefined])
  assert.equal(proc.disposeCount, 0)
  assert.equal(session.isUnavailable(), false, 'the healthy session stays usable')
})

test('PiAcpAgent: a prompt arriving while a command is parked stays queued behind it', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent } = makeAgent(proc, { deferredAdmissionTimeoutMs: 1_000 })

  proc.emit({ type: 'agent_start' })

  const compacting = agent.prompt(promptParams('/compact'))
  await tick()
  const queuedPrompt = agent.prompt(promptParams('hello'))
  await tick()
  assert.equal(proc.prompts.length, 0, 'the parked command still holds the FIFO against later prompts')

  proc.emit({ type: 'agent_settled' })
  assert.equal((await compacting).stopReason, 'end_turn')
  await tick()

  assert.deepEqual(compactions, [undefined])
  assert.deepEqual(
    proc.prompts.map((item: { message: string }) => item.message),
    ['hello'],
    'the queued prompt is dispatched only after the admitted command finished'
  )

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal((await queuedPrompt).stopReason, 'end_turn')
})

test('PiAcpAgent: cancelling a parked command settles locally and leaves pi untouched', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent, conn, session, sessions } = makeAgent(proc, { deferredAdmissionTimeoutMs: 1_000 })

  proc.emit({ type: 'agent_start' })
  const compacting = agent.prompt(promptParams('/compact'))
  await tick()

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await compacting).stopReason, 'cancelled')
  assert.deepEqual(compactions, [], 'a cancelled command never reaches pi')
  assert.equal(proc.abortCount, 0, 'the unrelated autonomous run must not be aborted')
  assert.equal(proc.disposeCount, 0, 'nothing of this command reached pi, so the channel stays healthy')
  assert.equal(session.isUnavailable(), false)
  assert.deepEqual(sessions.evicted, [], 'a healthy session is not evicted')
  assert.deepEqual(
    queueStates(conn).at(-1),
    { queueDepth: 0, running: false },
    'the released FIFO publishes terminal idle queue metadata'
  )

  // The FIFO is usable again once the foreign run settles.
  proc.emit({ type: 'agent_settled' })
  const after = agent.prompt(promptParams('/compact'))
  assert.equal((await after).stopReason, 'end_turn')
  assert.deepEqual(compactions, [undefined])
})

test('PiAcpAgent: a parked command fails closed when the out-of-band run never settles', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent, conn, session } = makeAgent(proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })

  await assert.rejects(agent.prompt(promptParams('/compact')), (error: unknown) => {
    assert.match(String((error as { message?: unknown }).message), /Timed out waiting for out-of-band pi work/i)
    return true
  })

  assert.deepEqual(compactions, [], 'the command never reached pi')
  assert.equal(proc.disposeCount, 1, 'the uncorrelatable channel is quarantined')
  assert.equal(session.isUnavailable(), true, 'the next request must restore a fresh subprocess')
  assert.deepEqual(
    queueStates(conn).at(-1),
    { queueDepth: 0, running: false },
    'the FIFO slot of the failed admission is released'
  )
})

test('PiAcpAgent: a command re-parks when a settlement and a new autonomous run share one stdout batch', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent } = makeAgent(proc, { deferredAdmissionTimeoutMs: 1_000 })

  proc.emit({ type: 'agent_start' })
  const compacting = agent.prompt(promptParams('/compact'))
  await tick()

  // pi's stdout records are dispatched as one synchronous batch, so a new
  // autonomous run can raise the gate again before the admitted command's
  // microtask runs. Admission must be revalidated when the body actually starts.
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'agent_start' })
  await tick()
  assert.deepEqual(compactions, [], 'the command must not race the run that started in the same batch')

  proc.emit({ type: 'agent_settled' })
  assert.equal((await compacting).stopReason, 'end_turn')
  assert.deepEqual(compactions, [undefined], 'it runs once the gate is genuinely clear')
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.disposeCount, 0)
})

test('PiAcpAgent: re-parking a command does not extend its bounded admission deadline', async () => {
  const proc = new FakePiRpcProcess() as any
  const compactions = trackCompaction(proc)
  const { agent } = makeAgent(proc, { deferredAdmissionTimeoutMs: 150 })

  proc.emit({ type: 'agent_start' })
  const compacting = agent.prompt(promptParams('/compact'))
  const startedAt = Date.now()
  await tick()

  // Re-park before the deadline. A per-park timer would restart here, pushing
  // the failure out to ~250ms instead of the original ~150ms budget.
  await sleep(100)
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'agent_start' })

  await assert.rejects(compacting, /Timed out waiting for out-of-band pi work/i)
  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs < 220, `admission must fail at its original deadline, but waited ${elapsedMs}ms`)
  assert.deepEqual(compactions, [], 'the command never reached pi')
  assert.equal(proc.disposeCount, 1, 'the uncorrelatable channel is quarantined')
})

test('PiAcpSession: an expired command admission rejects a queued prompt instead of reporting cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 30
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const parked = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()
  const queuedPrompt = session.prompt('hello')
  await tick()

  // The admission budget expires: the channel is fault-quarantined, which kills
  // it long before the child's termination event can arrive. The queued prompt
  // never ran, so it must reject rather than report a benign cancellation just
  // because `procTermination` is not populated yet.
  await assert.rejects(parked, /Timed out waiting for out-of-band pi work/i)
  await assert.rejects(queuedPrompt, (error: unknown) => {
    const record = error as { code?: unknown; message?: unknown }
    assert.equal(record.code, -32603)
    assert.match(String(record.message), /unrecoverable fault before this request could run/i)
    return true
  })

  assert.equal(ran, false, 'the parked command never ran')
  assert.equal(proc.prompts.length, 0, 'and the queued prompt is never dispatched')
  assert.equal(proc.disposeCount, 1, 'the uncorrelatable channel is quarantined')
  assert.equal(session.isUnavailable(), true)
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })
})

test('PiAcpSession: a cancel-quarantined channel still settles queued work as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  // A manual RPC pi will not abort, so cancellation must quarantine the channel.
  let releaseCompaction!: () => void
  proc.compact = () =>
    proc.pendingRequest(
      new Promise<void>(resolve => {
        releaseCompaction = resolve
      })
    )
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const running = session.runCommand(ctx => {
    void ctx
    return proc.compact()
  })
  await tick()
  const queuedPrompt = session.prompt('hello')
  await tick()

  // Client-driven cancellation keeps ACP cancellation semantics even though it
  // disposes the channel to release the un-abortable RPC.
  await session.cancel()
  releaseCompaction?.()

  assert.equal(await running, null)
  assert.equal(await queuedPrompt, 'cancelled')
  assert.equal(proc.disposeCount, 1, 'the pending RPC is released by quarantining the channel')
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: runCommand refuses to run local work once the child is gone', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emitTermination({ reason: 'exit', code: 7, signal: null, expected: false })

  let ran = false
  await assert.rejects(
    session.runCommand(async () => {
      ran = true
      return 'ok'
    }),
    /pi process exited unexpectedly \(code=7/
  )
  assert.equal(ran, false, 'a built-in must not report success for a session whose child is gone')
})

test('PiAcpSession: runCommand still reports a cancellation after an expected exit', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Adapter-driven teardown, not a fault.
  proc.emitTermination({ reason: 'exit', code: 0, signal: null, expected: true })

  let ran = false
  assert.equal(
    await session.runCommand(async () => {
      ran = true
      return 'ok'
    }),
    null
  )
  assert.equal(ran, false)
})

test('PiAcpSession: an unexpected exit fails a prompt queued behind a parked command', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 60_000
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const parked = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()
  const queuedPrompt = session.prompt('hello')
  await tick()

  proc.emitTermination({ reason: 'exit', code: 3, signal: null, expected: false })

  await assert.rejects(parked, /pi process exited unexpectedly \(code=3/)
  await assert.rejects(queuedPrompt, /pi process exited unexpectedly \(code=3/)
  assert.equal(ran, false)
  assert.equal(proc.prompts.length, 0, 'releasing the parked slot must not dispatch into a dead channel')
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })
})

test('PiAcpSession: an unexpected exit fails a built-in queued behind a parked command', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 60_000
  })

  proc.emit({ type: 'agent_start' })

  let parkedRan = false
  const parked = session.runCommand(async () => {
    parkedRan = true
    return 'parked'
  })
  await tick()

  // A second built-in waits in the FIFO. Its work may be purely local (`/name`
  // usage, `/changelog`), so admitting it would report success from a session
  // whose child is already gone.
  let queuedRan = false
  const queuedCommand = session.runCommand(async () => {
    queuedRan = true
    return 'queued'
  })
  await tick()

  proc.emitTermination({ reason: 'exit', code: 9, signal: null, expected: false })

  await assert.rejects(parked, /pi process exited unexpectedly \(code=9/)
  await assert.rejects(queuedCommand, /pi process exited unexpectedly \(code=9/)
  assert.equal(parkedRan, false)
  assert.equal(queuedRan, false, 'no local built-in may run against a dead session')
  assert.deepEqual(queueStates(conn).at(-1), { queueDepth: 0, running: false })
})

test('PiAcpSession: an unexpected exit rejects a parked command with the termination error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 1_000
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const command = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()
  assert.equal(ran, false, 'the command is parked behind the autonomous run')

  // A crashing child is not a cancellation: the parked command never ran, so
  // reporting a benign `cancelled` would claim work pi never performed.
  proc.emitTermination({ reason: 'exit', code: 1, signal: null, expected: false, stderrTail: 'boom' })

  await assert.rejects(command, /pi process exited unexpectedly \(code=1/)
  await assert.rejects(command, /Last stderr output: boom/)
  assert.equal(ran, false, 'the command body never runs')
  assert.equal(session.isUnavailable(), true, 'the session is unusable and must be restored')
})

test('PiAcpSession: an expected exit still settles a parked command as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 1_000
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const command = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()

  // Adapter-driven teardown keeps ACP cancellation semantics.
  proc.emitTermination({ reason: 'exit', code: 0, signal: null, expected: true })

  assert.equal(await command, null, 'an expected exit reports a cancellation, not a failure')
  assert.equal(ran, false)
})

test('PiAcpSession: cancelling before an unexpected exit keeps the parked command cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 1_000
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const command = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()

  // The client cancelled first, so the later child exit cannot reclassify that
  // settled cancellation as a failure.
  await session.cancel()
  proc.emitTermination({ reason: 'exit', code: 1, signal: null, expected: false })

  assert.equal(await command, null)
  assert.equal(ran, false)
  assert.equal(proc.abortCount, 0, 'a parked command never reached pi, so nothing is aborted')
})

test('PiAcpSession: shutdown settles a parked command without waiting out its admission timeout', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    deferredAdmissionTimeoutMs: 60_000
  })

  proc.emit({ type: 'agent_start' })

  let ran = false
  const command = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()

  await session.shutdown()

  assert.equal(await command, null)
  assert.equal(ran, false, 'a parked command is never admitted during shutdown')
})

test('PiAcpSession: a command queued behind a hard-failing prompt rejects and leaves the FIFO usable', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.prompt = async () => {
    throw new Error('pi prompt failed: socket hang up')
  }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Queued synchronously behind the active prompt, before its failure lands.
  const failing = session.prompt('hello')
  let ran = false
  const queuedCommand = session.runCommand(async () => {
    ran = true
    return 'ok'
  })

  const [promptResult, commandResult] = await Promise.allSettled([failing, queuedCommand])

  assert.equal(promptResult.status, 'rejected')
  assert.equal(commandResult.status, 'rejected', 'the queued command must not resolve null or hang')
  for (const result of [promptResult, commandResult]) {
    const reason = (result as PromiseRejectedResult).reason as { code?: unknown; message?: unknown }
    assert.equal(reason?.code, -32603)
    assert.match(String(reason?.message), /socket hang up/)
  }
  assert.equal(ran, false, 'a command that never got admitted does not run')

  await tick()
  assert.deepEqual(
    queueStates(conn).at(-1),
    { queueDepth: 0, running: false },
    'queue metadata settles idle rather than staying running:true'
  )

  // The failure did not quarantine the channel, so the FIFO must serve the
  // next request instead of staying wedged on stale activeCommand state.
  assert.equal(session.isUnavailable(), false)
  assert.equal(await session.runCommand(async () => 'second'), 'second')
})

test('PiAcpSession: an unexpected exit between runCommand entry and its admission rejects', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Admission resolves synchronously (the gate is clear), but the caller only
  // resumes a microtask later. Termination landing in that window must not let
  // a purely local built-in run and report success.
  let ran = false
  const call = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  proc.emitTermination({ reason: 'exit', code: 9, signal: null, expected: false })

  await assert.rejects(call, /pi process exited unexpectedly \(code=9/)
  assert.equal(ran, false, 'the command body must not run after the child is gone')
})

test('PiAcpSession: an unexpected exit while a command body runs rejects instead of returning its result', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let release!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  let publishedAfterExit = false

  const call = session.runCommand(async ctx => {
    await blocked
    // A result computed against a child that is gone must not reach the client.
    await ctx.sendSessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late success' } }
    })
    publishedAfterExit = true
    return 'ok'
  })
  await tick()

  proc.emitTermination({ reason: 'exit', code: 9, signal: null, expected: false })
  release()

  await assert.rejects(call, /pi process exited unexpectedly \(code=9/)
  assert.equal(publishedAfterExit, true, 'the body itself still finished; only its publication is suppressed')
  assert.equal(
    conn.updates.some(update => {
      const content = (update.update as { content?: { text?: unknown } }).content
      return content?.text === 'late success'
    }),
    false,
    'ctx.sendSessionUpdate must drop publications once the channel is terminal'
  )
})

test('PiAcpSession: an expected exit while a command body runs still reports a cancellation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let release!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const call = session.runCommand(async () => {
    await blocked
    return 'ok'
  })
  await tick()

  // Adapter-driven teardown keeps ACP cancellation semantics.
  proc.emitTermination({ reason: 'exit', code: 0, signal: null, expected: true })
  release()

  assert.equal(await call, null)
})

test('PiAcpSession: a fault quarantine while a command is parked rejects instead of cancelling', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // An autonomous run parks the command.
  proc.emit({ type: 'agent_start' })
  let ran = false
  const parked = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()

  // A nested top-level run makes the lifecycle uncorrelatable, so its
  // settlement fault-quarantines the channel (`dispose({ expected: false })`)
  // before any termination event exists. The parked command never ran.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(parked, (error: unknown) => {
    const record = error as { code?: unknown; message?: unknown }
    assert.equal(record.code, -32603)
    assert.match(String(record.message), /unrecoverable fault before this request could run/i)
    return true
  })
  assert.equal(ran, false)
  assert.equal(proc.disposeCount, 1, 'the uncorrelatable channel is quarantined')
  assert.equal(session.isUnavailable(), true)
})

test('PiAcpSession: an idle cancellation does not mask a later command crash', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // A harmless cancel with nothing running leaves no work to settle, but it
  // must not classify an unrelated later crash as a benign cancellation.
  await session.cancel()

  let release!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const call = session.runCommand(async () => {
    await blocked
    return 'ok'
  })
  await tick()

  proc.emitTermination({ reason: 'exit', code: 9, signal: null, expected: false })
  release()

  await assert.rejects(call, /pi process exited unexpectedly \(code=9/)
})

test('PiAcpSession: a cancellation landing while a command waits is not erased by its admission', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'agent_start' })
  let ran = false
  const parked = session.runCommand(async () => {
    ran = true
    return 'ok'
  })
  await tick()

  // Cancelled while parked: the command settles as cancelled and the reset at
  // admission must never be reached for it.
  await session.cancel()

  assert.equal(await parked, null)
  assert.equal(ran, false)

  // Only a command that is genuinely admitted on a live channel clears the
  // cancellation, so a crash after that is reported as the failure it is.
  proc.emit({ type: 'agent_settled' })
  assert.equal(await session.runCommand(async () => 'second'), 'second')

  proc.emitTermination({ reason: 'exit', code: 9, signal: null, expected: false })
  await assert.rejects(
    session.runCommand(async () => 'third'),
    /pi process exited unexpectedly \(code=9/
  )
})

test('PiAcpSession: runCommand refuses to run local work on a fault-quarantined channel', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // A fault quarantine kills the channel synchronously, so no termination event
  // exists yet -- the entry guard must still classify it as a failure rather
  // than a benign cancellation.
  session.dispose({ expected: false })

  let ran = false
  await assert.rejects(
    session.runCommand(async () => {
      ran = true
      return 'ok'
    }),
    /unrecoverable fault before this request could run/i
  )
  assert.equal(ran, false)
})

test('PiAcpSession: runCommand still reports a cancellation on an expected disposal', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  session.dispose()

  let ran = false
  assert.equal(
    await session.runCommand(async () => {
      ran = true
      return 'ok'
    }),
    null
  )
  assert.equal(ran, false)
})
