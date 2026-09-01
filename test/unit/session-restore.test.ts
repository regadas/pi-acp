import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn, fakeSessionConfigSync } from '../helpers/fakes.js'

class FakeSessions {
  restoredSession: any = null

  constructor(private readonly buildSession: (sessionId: string, params: any) => any) {}

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId ? this.restoredSession : undefined
  }

  // Restores spawn through the manager so every pi child is owned (and waited
  // for at shutdown) even when the restore disposes it.
  async spawnOwned(params: any) {
    return PiRpcProcess.spawn(params)
  }

  // No child was ever retired for these sessions, so the pre-spawn barrier is
  // a no-op here.
  async waitForRetiredProcesses() {}

  getOrCreate(sessionId: string, params: any) {
    if (!this.restoredSession) {
      this.restoredSession = this.buildSession(sessionId, params)
    }
    return this.restoredSession
  }
}

test('PiAcpAgent: prompt auto-restores a missing session from SessionStore', async () => {
  const conn = new FakeAgentSideConnection()
  const promptCalls: Array<{ message: string; images: unknown[] }> = []
  const spawnCalls: any[] = []
  const storeUpserts: any[] = []

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async prompt(message: string, images: unknown[]) {
      promptCalls.push({ message, images })
      return 'end_turn'
    },
    async cancel() {},
    wasCancelRequested() {
      return false
    }
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      onTermination: () => () => {},
      dispose: () => {},
      // Restore validation requires pi to report the requested session.
      getState: async () => ({
        isStreaming: false,
        sessionId: 'stored-session',
        sessionFile: '/tmp/store-project/session.jsonl'
      })
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'stored-session') return null
        return {
          sessionId,
          cwd: '/tmp/store-project',
          sessionFile: '/tmp/store-project/session.jsonl',
          updatedAt: new Date().toISOString()
        }
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'hello again' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/store-project',
        sessionPath: '/tmp/store-project/session.jsonl',
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(promptCalls, [{ message: 'hello again', images: [] }])
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'stored-session',
        cwd: '/tmp/store-project',
        sessionFile: '/tmp/store-project/session.jsonl'
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: setSessionConfigOption auto-restores via pi session discovery when SessionStore misses', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-restore-fallback-'))
  const sessionsDir = join(root, 'sessions', '--tmp--fallback-project--')
  const sessionFile = join(sessionsDir, '0000_restore_fallback.jsonl')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'fallback-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/fallback-project'
    }) + '\n',
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = root

  const storeUpserts: any[] = []
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  const spawnCalls: any[] = []
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' },
    // Restore validation requires pi to report the requested session.
    sessionId: 'fallback-session',
    sessionFile
  }

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    ...fakeSessionConfigSync(conn)
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      onTermination: () => () => {},
      dispose: () => {},
      getAvailableModels: async () => ({
        models: [
          { provider: 'test', id: 'alpha', name: 'Alpha' },
          { provider: 'test', id: 'beta', name: 'Beta' }
        ]
      }),
      getState: async () => state,
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get() {
        return null
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.setSessionConfigOption({
      sessionId: 'fallback-session',
      configId: 'model',
      value: 'test/beta'
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/fallback-project',
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
    assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      },
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      }
    ])
    assert.deepEqual(conn.updates, [
      {
        sessionId: 'fallback-session',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: restore discovery receives the request cwd', async () => {
  const conn = new FakeAgentSideConnection()
  const requestedCwd = '/tmp/requested-project'
  const sessionFile = '/tmp/requested-project/custom/s.jsonl'
  const observedCwds: Array<string | undefined> = []
  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc
  }))
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      getState: async () => ({ sessionId: 'requested-session', sessionFile })
    }) as any

  try {
    const agent = new PiAcpAgent(asAgentConn(conn)) as any
    const store = { upsert() {} }
    agent.store = store
    agent.repository = {
      store,
      async find(sessionId: string, cwd?: string) {
        observedCwds.push(cwd)
        return { sessionId, cwd: requestedCwd, sessionFile, title: null, updatedAt: null }
      }
    }
    agent.sessions = sessions

    const restored = await agent.restoreSession('requested-session', { cwd: requestedCwd })
    assert.equal(restored.cwd, requestedCwd)
    assert.deepEqual(observedCwds, [requestedCwd])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: active and in-flight restores still validate a request cwd', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection())) as any
  const recorded = { sessionId: 'cwd-session', cwd: '/tmp/recorded', proc: {} }
  const sessions = new FakeSessions(() => recorded)
  sessions.restoredSession = recorded
  agent.sessions = sessions

  await assert.rejects(() => agent.restoreSession('cwd-session', { cwd: '/tmp/wrong' }), /does not match/i)

  sessions.restoredSession = null
  agent.restoringSessions.set('cwd-session', Promise.resolve(recorded))
  await assert.rejects(() => agent.restoreSession('cwd-session', { cwd: '/tmp/wrong' }), /does not match/i)
})

test('PiAcpAgent: many stale cancels leave no epochs and spawn no restore process', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = new FakeSessions(() => {
      throw new Error('cancel should not restore a missing session')
    }) as any

    for (let i = 0; i < 1_000; i++) await agent.cancel({ sessionId: `stale-${i}` } as any)

    assert.equal((agent as any).cancellationEpochs.size, 0)
    assert.deepEqual(spawnCalls, [])
    assert.deepEqual(conn.updates, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
