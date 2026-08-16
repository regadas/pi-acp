import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Final adapter shutdown must not exit while a pi child is still being
// escalated from SIGTERM to SIGKILL, and must stay bounded when a child never
// reports termination.

class MockChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  readonly kills: Array<NodeJS.Signals | number> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal ?? 'SIGTERM')
    return true
  }
}

function asChild(mock: MockChild): ChildProcessWithoutNullStreams {
  return mock as unknown as ChildProcessWithoutNullStreams
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

/** Own a fake child through the manager's real spawn seam. */
async function spawnOwnedFake(manager: SessionManager, proc: FakePiRpcProcess): Promise<PiRpcProcess> {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc as unknown as PiRpcProcess
  try {
    return await manager.spawnOwned({ cwd: process.cwd() })
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }
}

function registerSession(manager: SessionManager, proc: FakePiRpcProcess, sessionId = 's1'): void {
  manager.getOrCreate(sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: [],
    proc: proc as unknown as PiRpcProcess
  })
}

test('SessionManager.disposeAllAndWait: disposes sessions and waits for child termination', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  registerSession(manager, proc)

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  assert.equal(proc.disposeCount, 1, 'shutdown disposes the session process')
  await tick()
  assert.equal(settled, false, 'shutdown must not complete while the child is still terminating')

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('SessionManager.disposeAllAndWait: stays bounded when a child never terminates', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  registerSession(manager, proc)

  // Resolves on the timeout instead of blocking adapter exit forever.
  await manager.disposeAllAndWait(20)
  assert.equal(proc.disposeCount, 1)
})

test('SessionManager.disposeAllAndWait: returns immediately with no sessions', async () => {
  await new SessionManager().disposeAllAndWait(5_000)
})

test('SessionManager.disposeAllAndWait: still waits for children disposed by an earlier close', async () => {
  const manager = new SessionManager()
  const closed = new FakePiRpcProcess()
  const live = new FakePiRpcProcess()
  registerSession(manager, closed, 'closed')
  registerSession(manager, live, 'live')

  // e.g. an ACP connection abort tore this session down before final shutdown.
  manager.close('closed')
  assert.equal(closed.disposeCount, 1)

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  live.emitTermination({ reason: 'exit', code: 0, expected: true })
  await tick()
  assert.equal(settled, false, 'a child disposed before shutdown is still being escalated and must be waited for')

  closed.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
  assert.equal(closed.disposeCount, 1, 'disposal stays idempotent across close and shutdown')
})

test('SessionManager.disposeAllAndWait: prior dispose of an already-terminated child does not park shutdown', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  registerSession(manager, proc)

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  manager.close('s1')

  await manager.disposeAllAndWait(5_000)
})

test('SessionManager.disposeAllAndWait: an evicted unavailable session is still awaited', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  registerSession(manager, proc)

  // A cancelled adapter command quarantines the channel; the agent then drops
  // the unavailable session through maybeGet/evictIfCurrent.
  manager.get('s1').dispose()
  assert.equal(proc.disposeCount, 1)
  assert.equal(manager.maybeGet('s1'), undefined, 'an unavailable session is dropped from the map')

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  await tick()
  assert.equal(settled, false, "the dropped session's child is still terminating")

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('SessionManager.disposeAllAndWait: waits for a child spawned by an in-flight create', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()

  // The spawn resolved, so the manager owns the child; the create is still
  // validating it (get_state) and has registered no session yet.
  const spawned = await spawnOwnedFake(manager, proc)
  assert.equal(spawned, proc as unknown as PiRpcProcess, 'spawnOwned hands back the spawned child')

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  assert.equal(proc.disposeCount, 1, 'an unregistered in-flight child is still signalled')
  await tick()
  assert.equal(settled, false, 'shutdown waits for it instead of orphaning it')

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('SessionManager.disposeAllAndWait: waits for a child a failed restore already disposed', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()

  // e.g. restoreSession spawned this child, then disposed it because pi
  // reported a different session; it never reached getOrCreate.
  await spawnOwnedFake(manager, proc)
  proc.dispose()
  assert.equal(proc.disposeCount, 1)

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  await tick()
  assert.equal(settled, false, 'a child disposed by a failure path is still terminating')
  assert.equal(proc.disposeCount, 1, 'disposal stays idempotent')

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('SessionManager.spawnOwned: a spawn finishing after teardown is disposed and awaited', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()

  manager.disposeAll()
  await spawnOwnedFake(manager, proc)
  assert.equal(proc.disposeCount, 1, 'a child spawned into a disposed manager must not stay alive')

  let settled = false
  const waited = manager.disposeAllAndWait(5_000).then(() => {
    settled = true
  })

  await tick()
  assert.equal(settled, false)

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('SessionManager.disposeAllAndWait: waits for a child that appears while its spawn is unresolved', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  const childCreated = deferred()
  const spawnResolved = deferred()

  const originalSpawn = PiRpcProcess.spawn
  // Mirrors the real spawn: the OS child exists (and is reported to its owner)
  // strictly before the spawn promise resolves.
  ;(PiRpcProcess as any).spawn = async (params: { onProcess?: (proc: PiRpcProcess) => void }) => {
    await childCreated.promise
    params.onProcess?.(proc as unknown as PiRpcProcess)
    await spawnResolved.promise
    return proc as unknown as PiRpcProcess
  }

  try {
    const spawning = manager.spawnOwned({ cwd: process.cwd() })

    let settled = false
    const waited = manager.disposeAllAndWait(5_000).then(() => {
      settled = true
    })

    await tick()
    assert.equal(proc.disposeCount, 0, 'no child exists yet')
    assert.equal(settled, false, 'shutdown must not exit while a spawn is still in flight')

    childCreated.resolve()
    await tick()
    assert.equal(proc.disposeCount, 1, 'the child is signalled as soon as its owner can see it')
    assert.equal(settled, false, 'shutdown waits for the late child instead of orphaning it')

    spawnResolved.resolve()
    await spawning
    await tick()
    assert.equal(settled, false, 'the child is still being escalated from SIGTERM to SIGKILL')

    proc.emitTermination({ reason: 'exit', code: 0, expected: true })
    await waited
    assert.equal(settled, true)
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }
})

test('SessionManager.disposeAllAndWait: an unresolved spawn cannot outlive the shared deadline', async () => {
  const manager = new SessionManager()
  const originalSpawn = PiRpcProcess.spawn
  // A spawn that never settles must not hold adapter exit open forever.
  ;(PiRpcProcess as any).spawn = () => new Promise<PiRpcProcess>(() => {})

  try {
    void manager.spawnOwned({ cwd: process.cwd() })
    await manager.disposeAllAndWait(20)
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }
})

test('SessionManager.disposeAllAndWait: a terminated child is dropped from the ownership set', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  await spawnOwnedFake(manager, proc)

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await tick()

  // Nothing is left to wait for, so shutdown does not park on a dead child.
  await manager.disposeAllAndWait(5_000)
})

test('PiAcpAgent.disposeAndWait: waits for the managed children through the session manager', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  registerSession(manager, proc)

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = manager

  let settled = false
  const waited = agent.disposeAndWait(5_000).then(() => {
    settled = true
  })

  await tick()
  assert.equal(settled, false)
  assert.equal(proc.disposeCount, 1)

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await waited
  assert.equal(settled, true)
})

test('PiRpcProcess.whenTerminated: resolves on child exit and immediately afterwards', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))

  let settled = false
  const waited = proc.whenTerminated().then(() => {
    settled = true
  })

  proc.dispose()
  assert.deepEqual(mock.kills, ['SIGTERM'], 'dispose signals the child before shutdown waits for it')
  await tick()
  assert.equal(settled, false, 'a disposed-but-live child has not terminated yet')

  mock.emit('exit', 0, null)
  mock.emit('close', 0, null)
  await waited
  assert.equal(settled, true)

  // Already-terminated children never park shutdown.
  await proc.whenTerminated()
})
