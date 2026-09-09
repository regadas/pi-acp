import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    old.set(key, process.env[key])
    process.env[key] = value
  }
  return run().finally(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function withMockSpawn<T>(spawn: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = spawn
  return run().finally(() => {
    PiRpcProcess.spawn = originalSpawn
  })
}

const baseParams = () => ({
  cwd: process.cwd(),
  mcpServers: [],
  conn: asAgentConn(new FakeAgentSideConnection()),
  fileCommands: []
})

// A create that fails *before* pi reported an authoritative sessionId/sessionFile
// cannot be retried by sessionId: no adapter mapping exists and `findPiSession`
// has no id to match, so nothing can ever open that child's file again. Bare
// disposal is correct there -- the replacement barrier is keyed by sessionId and
// would have no key. Once the identity is known (store-write and construction
// failures below), the child must be retired through the barrier instead.
test('SessionManager.create: a get_state failure disposes the spawned process and rejects', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    const proc = new FakePiRpcProcess()
    proc.getState = async () => {
      throw new Error('get_state broke')
    }

    await withMockSpawn(
      async () => proc,
      async () => {
        const manager = new SessionManager()
        await assert.rejects(() => manager.create(baseParams() as any), /get_state broke/)
        assert.equal(proc.disposeCount, 1)
      }
    )
  })
})

test('SessionManager.create: never fabricates a session ID when pi reports none', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    for (const state of [
      { isStreaming: false },
      { sessionId: 'sess-1', isStreaming: false },
      { sessionFile: '/tmp/sess-1.jsonl', isStreaming: false },
      { sessionId: '  ', sessionFile: '/tmp/sess-1.jsonl' }
    ]) {
      const proc = new FakePiRpcProcess()
      proc.state = state

      await withMockSpawn(
        async () => proc,
        async () => {
          const manager = new SessionManager()
          await assert.rejects(
            () => manager.create(baseParams() as any),
            /did not report an authoritative sessionId\/sessionFile/
          )
          assert.equal(proc.disposeCount, 1)
        }
      )
    }
  })
})

test('SessionManager.create: a session-store write failure disposes the spawned process and rejects', async () => {
  // Point the store at a path whose parent is a regular file so upsert throws.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-'))
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a directory\n', 'utf-8')

  await withEnv({ PI_ACP_DIR: join(blocker, 'nested') }, async () => {
    const proc = new FakePiRpcProcess()
    proc.state = { sessionId: 'sess-1', sessionFile: join(root, 'sess-1.jsonl'), isStreaming: false }

    await withMockSpawn(
      async () => proc,
      async () => {
        const manager = new SessionManager()
        await assert.rejects(() => manager.create(baseParams() as any))
        assert.equal(proc.disposeCount, 1)
        assert.equal(manager.maybeGet('sess-1'), undefined)
        assert.equal(proc.terminated, false, 'disposal only starts its termination')

        // pi created this session, so `findPiSession` can still discover the
        // file by scanning pi's directory even though the mapping write failed:
        // a session/load must not open it while this child can still append.
        await assert.rejects(
          manager.waitForRetiredProcesses('sess-1', 15),
          /did not exit within/i,
          'the barrier must gate the next restore of this session'
        )

        proc.emitTermination({ reason: 'exit', code: 0, expected: true })
        await manager.waitForRetiredProcesses('sess-1', 10)
      }
    )
  })
})

test('SessionManager.create: construction/subscription failure disposes the owned process', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    const proc = new FakePiRpcProcess()
    proc.state = { sessionId: 'sess-construct', sessionFile: '/tmp/sess-construct.jsonl' }
    ;(proc as any).onEvent = () => {
      throw new Error('subscription failed')
    }

    await withMockSpawn(
      async () => proc,
      async () => {
        const manager = new SessionManager()
        await assert.rejects(() => manager.create(baseParams() as any), /subscription failed/)
        assert.equal(proc.disposeCount, 1)
        assert.equal(manager.maybeGet('sess-construct'), undefined)
        assert.equal(proc.terminated, false)

        // The store mapping already exists here, so a later session/load can
        // target this exact file.
        await assert.rejects(manager.waitForRetiredProcesses('sess-construct', 15), /did not exit within/i)

        proc.emitTermination({ reason: 'exit', code: 0, expected: true })
        await manager.waitForRetiredProcesses('sess-construct', 10)
      }
    )
  })
})

test('SessionManager.create: a spawn finishing after disposeAll is disposed, never registered', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    const proc = new FakePiRpcProcess()
    proc.state = { sessionId: 'sess-late', sessionFile: '/tmp/sess-late.jsonl', isStreaming: false }

    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>(resolve => {
      releaseSpawn = resolve
    })

    await withMockSpawn(
      async () => {
        await spawnGate
        return proc
      },
      async () => {
        const manager = new SessionManager()
        const create = manager.create(baseParams() as any)
        manager.disposeAll()
        releaseSpawn()

        await assert.rejects(() => create, /session manager is disposed/)
        assert.equal(proc.disposeCount, 1)
        assert.equal(manager.maybeGet('sess-late'), undefined)
      }
    )
  })
})

test('SessionManager.getOrCreate: a losing fresh process is disposed when a registered session wins', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    const manager = new SessionManager()
    const winnerProc = new FakePiRpcProcess()
    const loserProc = new FakePiRpcProcess()

    const winner = manager.getOrCreate('sess-race', { ...baseParams(), proc: winnerProc as any } as any)
    const resolved = manager.getOrCreate('sess-race', { ...baseParams(), proc: loserProc as any } as any)

    assert.equal(resolved, winner, 'the registered session wins the race')
    assert.equal(loserProc.disposeCount, 1, 'the losing fresh process must be disposed')
    assert.equal(winnerProc.disposeCount, 0)
  })
})

test('SessionManager.getOrCreate: construction/subscription failure disposes the owned process', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  ;(proc as any).onEvent = () => {
    throw new Error('subscription failed')
  }

  assert.throws(
    () => manager.getOrCreate('sess-construct', { ...baseParams(), proc: proc as any } as any),
    /subscription failed/
  )
  assert.equal(proc.disposeCount, 1)
  assert.equal(manager.maybeGet('sess-construct'), undefined)
  await assert.rejects(manager.waitForRetiredProcesses('sess-construct', 15), /did not exit within/i)

  proc.emitTermination({ reason: 'exit', code: 0, expected: true })
  await manager.waitForRetiredProcesses('sess-construct', 10)
})

test('SessionManager.getOrCreate: refuses registration after disposeAll and disposes the process', async () => {
  await withEnv({ PI_ACP_DIR: mkdtempSync(join(tmpdir(), 'pi-acp-own-')) }, async () => {
    const manager = new SessionManager()
    manager.disposeAll()

    const proc = new FakePiRpcProcess()
    assert.throws(
      () => manager.getOrCreate('sess-x', { ...baseParams(), proc: proc as any } as any),
      /session manager is disposed/
    )
    assert.equal(proc.disposeCount, 1)
  })
})

test('PiAcpAgent: a restore spawn finishing after dispose() is disposed, never registered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-agent-'))
  await withEnv({ PI_ACP_DIR: root }, async () => {
    const proc = new FakePiRpcProcess()
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>(resolve => {
      releaseSpawn = resolve
    })

    await withMockSpawn(
      async () => {
        await spawnGate
        return proc
      },
      async () => {
        const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
        ;(agent as any).store = {
          get: () => ({
            sessionId: 'sess-restore',
            cwd: process.cwd(),
            sessionFile: join(root, 'sess-restore.jsonl'),
            updatedAt: new Date().toISOString()
          }),
          upsert: () => {},
          delete: () => {}
        }
        const manager = (agent as any).sessions as SessionManager

        const prompt = agent.prompt({
          sessionId: 'sess-restore',
          prompt: [{ type: 'text', text: 'hello' }]
        } as any)
        await new Promise(resolve => setTimeout(resolve, 0))

        agent.dispose()
        releaseSpawn()

        // The prompt settles as cancelled (teardown), but the late-spawned
        // process must be disposed and never registered.
        const result = await prompt
        assert.equal(result.stopReason, 'cancelled')
        assert.equal(proc.disposeCount, 1)
        assert.equal(manager.maybeGet('sess-restore'), undefined)
      }
    )
  })
})

function makeRestoreAgent(root: string, sessionFile: string) {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get: () => ({
      sessionId: 'sess-restore',
      cwd: process.cwd(),
      sessionFile,
      updatedAt: new Date().toISOString()
    }),
    upsert: () => {},
    delete: () => {}
  }
  void root
  const manager = (agent as any).sessions as SessionManager
  const restore = () => (agent as any).restoreSession('sess-restore') as Promise<unknown>
  return { agent, manager, restore }
}

test('PiAcpAgent: restore rejects and disposes when pi reports a different session identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-agent-'))
  const sessionFile = join(root, 'sess-restore.jsonl')

  for (const state of [
    // Different session id entirely.
    { sessionId: 'someone-else', sessionFile, isStreaming: false },
    // Right id, no session file.
    { sessionId: 'sess-restore', isStreaming: false },
    // Right id, different file than the stored mapping.
    { sessionId: 'sess-restore', sessionFile: join(root, 'other.jsonl'), isStreaming: false }
  ]) {
    const proc = new FakePiRpcProcess()
    proc.state = state

    await withMockSpawn(
      async () => proc,
      async () => {
        const { manager, restore } = makeRestoreAgent(root, sessionFile)
        await assert.rejects(restore(), /did not restore the requested session/)
        assert.equal(proc.disposeCount, 1, 'mismatched child must be disposed before installation')
        assert.equal(manager.maybeGet('sess-restore'), undefined)
      }
    )
  }
})

test(
  'PiAcpAgent: restore accepts realpath-equivalent stored and reported session files',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-realpath-'))
    const realDir = join(root, 'real')
    const aliasDir = join(root, 'alias')
    mkdirSync(realDir)
    symlinkSync(realDir, aliasDir, 'dir')
    const realFile = join(realDir, 'sess-restore.jsonl')
    const aliasFile = join(aliasDir, 'sess-restore.jsonl')
    writeFileSync(realFile, '{}\n', 'utf8')

    const proc = new FakePiRpcProcess()
    proc.state = { sessionId: 'sess-restore', sessionFile: realFile, isStreaming: false }
    await withMockSpawn(
      async () => proc,
      async () => {
        const { agent, manager, restore } = makeRestoreAgent(root, aliasFile)
        const restored = await restore()
        assert.ok(restored)
        assert.equal(manager.maybeGet('sess-restore')?.proc, proc as any)
        agent.dispose()
      }
    )
  }
)

test('PiAcpAgent: restore rejects and disposes when the post-spawn state probe fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-agent-'))
  const sessionFile = join(root, 'sess-restore.jsonl')
  const proc = new FakePiRpcProcess()
  proc.getState = async () => {
    throw new Error('get_state broke during restore')
  }

  await withMockSpawn(
    async () => proc,
    async () => {
      const { manager, restore } = makeRestoreAgent(root, sessionFile)
      await assert.rejects(restore(), /get_state broke during restore/)
      assert.equal(proc.disposeCount, 1)
      assert.equal(manager.maybeGet('sess-restore'), undefined)
    }
  )
})

test('PiAcpAgent: teardown during the restore state probe disposes the child, never registers it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-own-agent-'))
  const sessionFile = join(root, 'sess-restore.jsonl')
  const proc = new FakePiRpcProcess()
  proc.state = { sessionId: 'sess-restore', sessionFile, isStreaming: false }

  let releaseState!: () => void
  const stateGate = new Promise<void>(resolve => {
    releaseState = resolve
  })
  const realGetState = proc.getState.bind(proc)
  proc.getState = async () => {
    await stateGate
    return realGetState()
  }

  await withMockSpawn(
    async () => proc,
    async () => {
      const { agent, manager, restore } = makeRestoreAgent(root, sessionFile)
      const pending = restore()
      await new Promise(resolve => setTimeout(resolve, 0))

      agent.dispose()
      releaseState()

      await assert.rejects(pending, /agent is disposed/)
      assert.equal(proc.disposeCount, 1)
      assert.equal(manager.maybeGet('sess-restore'), undefined)
    }
  )
})

test(
  'SessionManager.create: newly created session directories are private; existing modes are unchanged',
  { skip: process.platform === 'win32' },
  async () => {
    const { statSync, chmodSync, rmSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-private-sessions-'))
    try {
      await withEnv({ PI_ACP_DIR: join(root, 'acp') }, async () => {
        for (const existing of [false, true]) {
          const directory = join(root, existing ? 'existing' : 'new')
          if (existing) {
            mkdirSync(directory)
            chmodSync(directory, 0o755)
          }
          const proc = new FakePiRpcProcess()
          proc.state = {
            sessionId: String(existing),
            sessionFile: join(directory, 'session.jsonl')
          }
          await withMockSpawn(
            async () => proc,
            async () => {
              const manager = new SessionManager()
              await manager.create(baseParams() as any)
              assert.equal(statSync(directory).mode & 0o777, existing ? 0o755 : 0o700)
              manager.disposeAll()
            }
          )
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
