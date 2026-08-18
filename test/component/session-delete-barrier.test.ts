import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// pi appends to its session file by path (`appendFileSync`), reopening it for
// every write. `dispose()` only starts the SIGTERM -> SIGKILL escalation, so a
// still-exiting child recreates a file deleted underneath it as a stray stub and
// the deletion silently does not stick. `session/delete` therefore waits
// (bounded, fail closed) for the retired child to actually exit before
// unlinking, and leaves the file intact if that wait expires.

const SESSION_ID = 'sess-delete-barrier'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick()
}

/** Real pi session directory + adapter store, both under temp dirs. */
function withPiDirs<T>(run: (sessionFile: string, projectDir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-barrier-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-delete-barrier-store-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  const sessionFile = join(sessionsDir, '0000_delete_barrier.jsonl')
  // A real directory: session/load and session/resume validate their cwd.
  const projectDir = join(root, 'project')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: projectDir
    }) + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  const restore = () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }

  return run(sessionFile, projectDir).finally(restore)
}

function makeAgent(proc: FakePiRpcProcess, timeoutMs: number, cwd = '/p') {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  ;(agent as any).replacementTerminationTimeoutMs = timeoutMs
  // Nothing here needs the deferred available_commands_update.
  ;(agent as any).scheduleDeferred = () => {}

  manager.getOrCreate(SESSION_ID, {
    cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  return { agent, manager }
}

/** Count spawns so a test can prove no replacement child was ever created. */
function countingSpawn() {
  const original = PiRpcProcess.spawn
  const state = { count: 0 }
  ;(PiRpcProcess as any).spawn = async () => {
    state.count += 1
    return new FakePiRpcProcess() as unknown as PiRpcProcess
  }
  return {
    state,
    restore() {
      PiRpcProcess.spawn = original
    }
  }
}

test('PiAcpAgent: deleteSession waits for the retired child to exit before unlinking', async () => {
  await withPiDirs(async sessionFile => {
    const proc = new FakePiRpcProcess()
    const { agent, manager } = makeAgent(proc, 2_000)

    const deleting = agent.deleteSession({ sessionId: SESSION_ID })
    await settle()

    assert.equal(proc.disposeCount, 1, 'the session is closed first')
    assert.equal(proc.terminated, false, 'but its child has not exited yet')
    assert.ok(existsSync(sessionFile), 'the file must not be unlinked while pi can still append to it')

    proc.emitTermination({ expected: true, code: 0 })

    assert.deepEqual(await deleting, {})
    assert.ok(!existsSync(sessionFile), 'deletion completes once the child is gone')
    assert.equal(manager.maybeGet(SESSION_ID), undefined)
  })
})

test('PiAcpAgent: deleteSession fails closed and keeps the session file when the child will not exit', async () => {
  await withPiDirs(async sessionFile => {
    const proc = new FakePiRpcProcess()
    const { agent } = makeAgent(proc, 25)
    const store = (agent as any).store as SessionStore
    store.upsert({ sessionId: SESSION_ID, cwd: '/p', sessionFile })

    await assert.rejects(agent.deleteSession({ sessionId: SESSION_ID }), (error: unknown) => {
      const record = error as { code?: unknown; message?: unknown }
      assert.equal(record.code, -32603)
      assert.match(String(record.message), /did not exit within 25ms/i)
      return true
    })

    assert.ok(existsSync(sessionFile), 'a deletion that could not be made safe leaves the file intact')
    assert.equal(
      store.get(SESSION_ID)?.sessionFile,
      sessionFile,
      'and keeps the mapping, so the session stays loadable rather than being orphaned'
    )

    // The barrier clears once the child finally exits, so a retry can delete.
    proc.emitTermination({ expected: true, code: 0 })
    assert.deepEqual(await agent.deleteSession({ sessionId: SESSION_ID }), {})
    assert.ok(!existsSync(sessionFile))
    assert.equal(store.get(SESSION_ID), null)
  })
})

// A delete is a transaction: close, wait for the retired child to exit, unlink,
// tombstone. `closingSessions` only covers the first step, so without a marker
// for the whole transaction a concurrent resume/load restores the session
// between the close and the unlink -- and its fresh child recreates the file the
// delete is about to remove, so the deletion silently does not stick.
for (const entry of [
  {
    name: 'resume',
    request: (agent: PiAcpAgent, cwd: string) => agent.resumeSession({ sessionId: SESSION_ID, cwd, mcpServers: [] })
  },
  {
    name: 'load',
    request: (agent: PiAcpAgent, cwd: string) => agent.loadSession({ sessionId: SESSION_ID, cwd, mcpServers: [] })
  }
] as const) {
  test(`PiAcpAgent: a concurrent session/${entry.name} cannot restore a session mid-delete`, async () => {
    await withPiDirs(async (sessionFile, projectDir) => {
      const proc = new FakePiRpcProcess()
      const { agent, manager } = makeAgent(proc, 2_000, projectDir)
      const store = (agent as any).store as SessionStore
      store.upsert({ sessionId: SESSION_ID, cwd: projectDir, sessionFile })
      const spawn = countingSpawn()

      try {
        const deleting = agent.deleteSession({ sessionId: SESSION_ID })
        await settle()

        // The delete is now past its close and parked waiting for the child to
        // exit, with the file still on disk.
        assert.equal(proc.disposeCount, 1)
        assert.equal(proc.terminated, false)
        assert.ok(existsSync(sessionFile))

        await assert.rejects(entry.request(agent, projectDir), (error: unknown) => {
          const record = error as { code?: unknown; message?: unknown }
          assert.equal(record.code, -32800)
          assert.match(String(record.message), /session is being deleted/i)
          return true
        })

        assert.equal(spawn.state.count, 0, 'no replacement child may open the file being deleted')
        assert.equal(manager.maybeGet(SESSION_ID), undefined, 'and nothing is registered behind the delete')

        proc.emitTermination({ expected: true, code: 0 })
        assert.deepEqual(await deleting, {})

        assert.ok(!existsSync(sessionFile), 'the deletion sticks')
        assert.equal(store.get(SESSION_ID), null)
        assert.equal(spawn.state.count, 0)

        // Admission reopens once the transaction finished; the session is gone.
        await assert.rejects(entry.request(agent, projectDir), (error: unknown) => {
          const record = error as { code?: unknown }
          assert.equal(record.code, -32002, 'a deleted session is reported as not found, not as deleting')
          return true
        })
      } finally {
        spawn.restore()
      }
    })
  })
}

test('PiAcpAgent: a concurrent session/prompt cannot restore a session mid-delete', async () => {
  await withPiDirs(async (sessionFile, projectDir) => {
    const proc = new FakePiRpcProcess()
    const { agent } = makeAgent(proc, 2_000, projectDir)
    const store = (agent as any).store as SessionStore
    store.upsert({ sessionId: SESSION_ID, cwd: projectDir, sessionFile })
    const spawn = countingSpawn()

    try {
      const deleting = agent.deleteSession({ sessionId: SESSION_ID })
      await settle()

      await assert.rejects(
        agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: 'text', text: 'hello' }] } as any),
        /session is being deleted/i
      )
      assert.equal(spawn.state.count, 0, 'a prompt must not spawn a writer on the file being deleted')

      proc.emitTermination({ expected: true, code: 0 })
      assert.deepEqual(await deleting, {})
      assert.ok(!existsSync(sessionFile))
      assert.equal(spawn.state.count, 0)
    } finally {
      spawn.restore()
    }
  })
})

test('PiAcpAgent: a failed delete releases admission so the session stays usable', async () => {
  await withPiDirs(async (sessionFile, projectDir) => {
    const proc = new FakePiRpcProcess()
    const replacement = new FakePiRpcProcess()
    replacement.state = { isStreaming: false, sessionId: SESSION_ID, sessionFile }
    const { agent } = makeAgent(proc, 25, projectDir)
    const store = (agent as any).store as SessionStore
    store.upsert({ sessionId: SESSION_ID, cwd: projectDir, sessionFile })

    const original = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => replacement as unknown as PiRpcProcess

    try {
      await assert.rejects(agent.deleteSession({ sessionId: SESSION_ID }), /did not exit within 25ms/i)
      assert.ok(existsSync(sessionFile), 'the file survives a deletion that could not be made safe')

      // The marker must not leak: the session is still real, so it stays usable
      // once its retired child exits.
      proc.emitTermination({ expected: true, code: 0 })
      const resumed = await agent.resumeSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] })
      assert.ok(resumed)
    } finally {
      PiRpcProcess.spawn = original
      agent.dispose()
    }
  })
})

test('PiAcpAgent: concurrent deletes of one session share a single transaction', async () => {
  await withPiDirs(async (sessionFile, projectDir) => {
    const proc = new FakePiRpcProcess()
    const { agent } = makeAgent(proc, 2_000, projectDir)

    const first = agent.deleteSession({ sessionId: SESSION_ID })
    const second = agent.deleteSession({ sessionId: SESSION_ID })
    await settle()

    assert.ok(existsSync(sessionFile), 'neither delete may unlink before the child exits')
    proc.emitTermination({ expected: true, code: 0 })

    assert.deepEqual(await first, {})
    assert.deepEqual(await second, {})
    assert.ok(!existsSync(sessionFile))
    assert.equal(proc.disposeCount, 1, 'the shared transaction closes the session once')
  })
})

test('PiAcpAgent: deleteSession unlinks immediately when the child already exited', async () => {
  await withPiDirs(async sessionFile => {
    const proc = new FakePiRpcProcess()
    // A child that exits on SIGTERM, as a healthy pi does.
    proc.terminateOnDispose = true
    const { agent } = makeAgent(proc, 25)

    assert.deepEqual(await agent.deleteSession({ sessionId: SESSION_ID }), {})
    assert.ok(!existsSync(sessionFile))
    assert.equal(proc.terminated, true)
  })
})
