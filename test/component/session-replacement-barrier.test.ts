import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// pi session files have no writer coordination: each pi process keeps its own
// in-memory view while appending to the shared history. `dispose()` only starts
// the SIGTERM -> SIGKILL escalation, so a replacement that spawns immediately
// can open the same session file while the child it replaces is still alive.
// Restoring a session therefore waits (bounded, fail closed) for every child
// previously retired for that session to actually exit.

const SESSION_FILE = '/tmp/pi-acp-barrier-session.jsonl'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick()
}

/** An agent whose store maps `sessionId` to SESSION_FILE, with no session registered. */
function makeBareAgent(sessionId: string) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const cwd = process.cwd()
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd, sessionFile: SESSION_FILE }),
    upsert: () => {},
    delete: () => {}
  }
  // Nothing needs the deferred available_commands_update here.
  ;(agent as any).scheduleDeferred = () => {}

  return { agent, manager, conn, cwd }
}

function makeAgent(sessionId: string, oldProc: FakePiRpcProcess, replacementProc: FakePiRpcProcess) {
  const bare = makeBareAgent(sessionId)

  // Restore validation requires pi to report the requested session.
  replacementProc.state = { isStreaming: false, sessionId, sessionFile: SESSION_FILE }

  bare.manager.getOrCreate(sessionId, {
    cwd: bare.cwd,
    mcpServers: [],
    conn: asAgentConn(bare.conn),
    proc: oldProc as any,
    fileCommands: []
  })

  return bare
}

function registerProc(manager: SessionManager, sessionId: string, proc: FakePiRpcProcess) {
  return manager.getOrCreate(sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(new FakeAgentSideConnection()),
    proc: proc as any,
    fileCommands: []
  })
}

/**
 * Count spawns and hand back the prepared children in order (the last one is
 * reused once the list is exhausted).
 */
function stubSpawn(...procs: FakePiRpcProcess[]) {
  const original = PiRpcProcess.spawn
  const state = { count: 0 }
  ;(PiRpcProcess as any).spawn = async () => {
    const proc = procs[Math.min(state.count, procs.length - 1)]!
    state.count += 1
    return proc
  }
  return {
    state,
    restore() {
      PiRpcProcess.spawn = original
    }
  }
}

test('PiAcpAgent: a replacement pi process is not spawned until the retired child exits', async () => {
  const sessionId = 's-barrier-wait'
  const oldProc = new FakePiRpcProcess()
  const replacementProc = new FakePiRpcProcess()
  const { agent, manager, cwd } = makeAgent(sessionId, oldProc, replacementProc)
  const spawn = stubSpawn(replacementProc)
  ;(agent as any).replacementTerminationTimeoutMs = 1_000

  try {
    // Retire the live child. Disposal only signals it; the child has not exited.
    manager.close(sessionId)
    assert.equal(oldProc.disposeCount, 1)
    assert.equal(oldProc.terminated, false, 'the retired child is still running')

    const resume = agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    await settle()
    assert.equal(spawn.state.count, 0, 'no second pi process may open the session file yet')

    // The child finally exits.
    oldProc.emitTermination({ expected: true, code: 0 })

    await resume
    assert.equal(spawn.state.count, 1, 'the replacement spawns only after the retired child exited')
    assert.equal(manager.maybeGet(sessionId)?.proc, replacementProc as any)
    manager.close(sessionId)
  } finally {
    spawn.restore()
  }
})

test('PiAcpAgent: a retired child that never exits fails the restore closed instead of double-opening', async () => {
  const sessionId = 's-barrier-fail-closed'
  const oldProc = new FakePiRpcProcess()
  const replacementProc = new FakePiRpcProcess()
  const { agent, manager, cwd } = makeAgent(sessionId, oldProc, replacementProc)
  const spawn = stubSpawn(replacementProc)
  ;(agent as any).replacementTerminationTimeoutMs = 25

  try {
    manager.close(sessionId)

    await assert.rejects(agent.resumeSession({ sessionId, cwd, mcpServers: [] }), (error: unknown) => {
      const record = error as { code?: unknown; message?: unknown }
      assert.equal(record.code, -32603)
      assert.match(String(record.message), /refusing to start a second process on the same session file/i)
      return true
    })

    assert.equal(spawn.state.count, 0, 'the barrier must fail closed rather than spawn a concurrent writer')
    assert.equal(replacementProc.disposeCount, 0)
  } finally {
    spawn.restore()
  }
})

// A restore that fails *after* spawning has already opened the session file, so
// its child must be retired through the barrier rather than bare-disposed --
// otherwise an immediate retry (a client simply retrying the failed request)
// spawns a second writer while the first is still being escalated.
for (const seam of [
  {
    name: 'validation rejects the reported session identity',
    sessionId: 's-barrier-identity',
    expected: /did not restore the requested session/i,
    prepare(proc: FakePiRpcProcess, sessionId: string) {
      proc.state = { isStreaming: false, sessionId: `not-${sessionId}`, sessionFile: SESSION_FILE }
    }
  },
  {
    name: 'the state probe fails',
    sessionId: 's-barrier-getstate',
    expected: /pi did not report its session state/i,
    prepare(proc: FakePiRpcProcess) {
      proc.getState = async () => {
        throw new Error('pi get_state failed: channel closed')
      }
    }
  }
] as const) {
  test(`PiAcpAgent: a restore that fails because ${seam.name} blocks an immediate retry`, async () => {
    const { sessionId } = seam
    const rejected = new FakePiRpcProcess()
    const accepted = new FakePiRpcProcess()
    seam.prepare(rejected, sessionId)
    accepted.state = { isStreaming: false, sessionId, sessionFile: SESSION_FILE }

    const { agent, manager, cwd } = makeBareAgent(sessionId)
    const spawn = stubSpawn(rejected, accepted)
    ;(agent as any).replacementTerminationTimeoutMs = 1_000

    try {
      await assert.rejects(agent.resumeSession({ sessionId, cwd, mcpServers: [] }), seam.expected)
      assert.equal(spawn.state.count, 1)
      assert.equal(rejected.disposeCount, 1, 'the rejected child is disposed')
      assert.equal(rejected.terminated, false, 'disposal only starts its termination')

      const retry = agent.resumeSession({ sessionId, cwd, mcpServers: [] })
      await settle()
      assert.equal(spawn.state.count, 1, 'the retry must not open the session file a second time')

      rejected.emitTermination({ expected: true, code: 0 })

      await retry
      assert.equal(spawn.state.count, 2, 'the retry spawns only after the rejected child exited')
      assert.equal(manager.maybeGet(sessionId)?.proc, accepted as any)
      manager.close(sessionId)
    } finally {
      spawn.restore()
    }
  })
}

test('PiAcpAgent: a restore parked on the barrier cannot spawn after final shutdown drained', async () => {
  const sessionId = 's-barrier-shutdown-orphan'
  const oldProc = new FakePiRpcProcess()
  const replacementProc = new FakePiRpcProcess()
  const { agent, manager, cwd } = makeAgent(sessionId, oldProc, replacementProc)
  const spawn = stubSpawn(replacementProc)
  ;(agent as any).replacementTerminationTimeoutMs = 1_000

  try {
    manager.close(sessionId)
    const resume = agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    await settle()
    assert.equal(spawn.state.count, 0, 'the restore is parked on the retirement barrier')

    // A restore waiting on the barrier is registered in neither `owned` nor
    // `pendingSpawns`, so once the retired child exits, final shutdown can
    // drain to empty and let the adapter exit while this restore is still
    // about to resume.
    oldProc.emitTermination({ expected: true, code: 0 })
    await agent.disposeAndWait(1_000)

    await assert.rejects(resume, /session manager is disposed/i)
    assert.equal(spawn.state.count, 0, 'a child spawned after the drain returned would never be awaited or SIGKILLed')
    assert.equal(replacementProc.disposeCount, 0, 'because no replacement child was ever created')
  } finally {
    spawn.restore()
  }
})

test('SessionManager: a registration race loser is retired through the barrier', async () => {
  const manager = new SessionManager()
  const winner = new FakePiRpcProcess()
  const loser = new FakePiRpcProcess()

  const registered = registerProc(manager, 's-race-loser', winner)
  // A concurrent restore hands over its own child for the same session.
  assert.equal(registerProc(manager, 's-race-loser', loser), registered)
  assert.equal(loser.disposeCount, 1, 'the losing child is disposed')

  await assert.rejects(
    manager.waitForRetiredProcesses('s-race-loser', 15),
    /did not exit within/i,
    'and it gates the next restore until it actually exits'
  )

  loser.emitTermination({ expected: true, code: 0 })
  await manager.waitForRetiredProcesses('s-race-loser', 10)

  manager.close('s-race-loser')
  winner.emitTermination({ expected: true, code: 0 })
})

test('SessionManager: a child handed over after teardown is retired, not just disposed', async () => {
  const manager = new SessionManager()
  const late = new FakePiRpcProcess()
  manager.disposeAll()

  assert.throws(() => registerProc(manager, 's-late', late), /disposed/i)
  assert.equal(late.disposeCount, 1)
  await assert.rejects(manager.waitForRetiredProcesses('s-late', 15), /did not exit within/i)

  late.emitTermination({ expected: true, code: 0 })
  await manager.waitForRetiredProcesses('s-late', 10)
})

test('SessionManager: the replacement barrier is scoped per session and clears after termination', async () => {
  const manager = new SessionManager()
  const procA = new FakePiRpcProcess()
  const procB = new FakePiRpcProcess()

  registerProc(manager, 's-a', procA)
  registerProc(manager, 's-b', procB)

  // Nothing retired yet: the barrier is a no-op for every session.
  await manager.waitForRetiredProcesses('s-a', 10)
  await manager.waitForRetiredProcesses('s-unknown', 10)

  manager.close('s-a')

  // A child retired for another session must not hold this one back.
  await manager.waitForRetiredProcesses('s-b', 10)

  await assert.rejects(manager.waitForRetiredProcesses('s-a', 15), /did not exit within 15ms/i)

  procA.emitTermination({ expected: true, code: 0 })
  // Once it exited, the barrier stops gating this session entirely.
  await manager.waitForRetiredProcesses('s-a', 10)
  await manager.waitForRetiredProcesses('s-a', 10)

  manager.close('s-b')
  procB.emitTermination({ expected: true, code: 0 })
  await manager.waitForRetiredProcesses('s-b', 10)
})

test('SessionManager: a child retired while the barrier waits is also awaited', async () => {
  const manager = new SessionManager()
  const first = new FakePiRpcProcess()
  const second = new FakePiRpcProcess()

  const register = (proc: FakePiRpcProcess) => registerProc(manager, 's-race', proc)

  register(first)
  manager.close('s-race')

  const barrier = manager.waitForRetiredProcesses('s-race', 1_000)
  let settled = false
  void barrier.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )

  // A close racing the wait retires a second child for the same session.
  register(second)
  manager.close('s-race')

  first.emitTermination({ expected: true, code: 0 })
  await settle()
  assert.equal(settled, false, 'the barrier must also wait for the child retired mid-wait')

  second.emitTermination({ expected: true, code: 0 })
  await barrier
  assert.equal(settled, true)
})

// A child that reported a *different* session than the one it was asked for may
// append to either file, and `findPiSession` discovers a session by scanning
// pi's own directory. Retiring it under only the requested id would leave a
// restore for the reported id free to spawn a second writer immediately.
test('PiAcpAgent: an identity-mismatch retirement also gates a restore for the reported session', async () => {
  const requestedId = 's-mismatch-requested'
  const reportedId = 's-mismatch-reported'
  const reportedFile = '/tmp/pi-acp-barrier-reported.jsonl'
  const cwd = process.cwd()

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  ;(agent as any).store = {
    get: (sessionId: string) =>
      sessionId === reportedId
        ? { sessionId, cwd, sessionFile: reportedFile }
        : { sessionId, cwd, sessionFile: SESSION_FILE },
    upsert: () => {},
    delete: () => {}
  }
  ;(agent as any).scheduleDeferred = () => {}
  ;(agent as any).replacementTerminationTimeoutMs = 1_000

  // The child answers with the reported identity, so restore validation rejects it.
  const rejected = new FakePiRpcProcess()
  rejected.state = { isStreaming: false, sessionId: reportedId, sessionFile: reportedFile }
  const accepted = new FakePiRpcProcess()
  accepted.state = { isStreaming: false, sessionId: reportedId, sessionFile: reportedFile }

  const spawn = stubSpawn(rejected, accepted)
  try {
    await assert.rejects(
      agent.resumeSession({ sessionId: requestedId, cwd, mcpServers: [] }),
      /did not restore the requested session/i
    )
    assert.equal(spawn.state.count, 1)
    assert.equal(rejected.disposeCount, 1)
    assert.equal(rejected.terminated, false, 'disposal only starts its termination')

    // A load for the identity pi actually reported must wait for that very child.
    const byReportedId = agent.resumeSession({ sessionId: reportedId, cwd, mcpServers: [] })
    await settle()
    assert.equal(spawn.state.count, 1, 'the reported identity must not open the same writer concurrently')

    rejected.emitTermination({ expected: true, code: 0 })

    await byReportedId
    assert.equal(spawn.state.count, 2, 'it spawns only after the rejected child exited')
    manager.close(reportedId)
  } finally {
    spawn.restore()
  }
})

test('SessionManager: every retirement alias gates a wait and is cleared on termination', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  const aliases = ['/tmp/pi-acp-alias-requested.jsonl', 'reported-id', '/tmp/pi-acp-alias-reported.jsonl']

  manager.retireProcess('requested-id', proc as any, aliases)

  for (const key of ['requested-id', ...aliases]) {
    await assert.rejects(
      manager.waitForRetiredProcesses(key, 15),
      /did not exit within/i,
      `alias ${key} must gate a replacement`
    )
  }

  // A wait keyed by several identities at once resolves to the same child.
  await assert.rejects(manager.waitForRetiredProcesses(['requested-id', aliases[0]!], 15), /did not exit within/i)

  proc.emitTermination({ expected: true, code: 0 })
  await tick()

  for (const key of ['requested-id', ...aliases]) {
    await manager.waitForRetiredProcesses(key, 15)
  }
  assert.equal((manager as any).retiring.size, 0, 'no alias may outlive the child it gated')
})

test('SessionManager: unknown and empty barrier keys never gate a replacement', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  manager.retireProcess('known-id', proc as any, ['', '/tmp/pi-acp-known.jsonl'])

  // An empty alias must not become a shared key every other session waits on.
  await manager.waitForRetiredProcesses('', 15)
  await manager.waitForRetiredProcesses([], 15)
  await manager.waitForRetiredProcesses('other-id', 15)
  await assert.rejects(manager.waitForRetiredProcesses('known-id', 15), /did not exit within/i)

  proc.emitTermination({ expected: true, code: 0 })
  await tick()
})
