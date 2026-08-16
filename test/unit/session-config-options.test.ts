import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn, fakeSessionConfigSync } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-config-options-'))

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for model and thinking selectors', async () => {
  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: TEST_CWD,
      ...fakeSessionConfigSync(conn),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: { provider: 'test', id: 'beta', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any
    // Local seam: swallow deferred notifications instead of patching timers.
    ;(agent as any).scheduleDeferred = () => {}

    const result = await agent.newSession({ cwd: TEST_CWD, mcpServers: [] } as any)

    // Model state is exposed only through standard configOptions; the legacy
    // custom root `models` field is gone.
    assert.equal('models' in (result as any), false)
    assert.equal(result.modes?.currentModeId, 'high')
    assert.deepEqual(result.configOptions, [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: 'test/beta',
        options: [
          { value: 'test/alpha', name: 'test/Alpha', description: null },
          { value: 'test/beta', name: 'test/Beta', description: null }
        ]
      },
      {
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set the reasoning effort for this session',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Thinking: off', description: null },
          { value: 'minimal', name: 'Thinking: minimal', description: null },
          { value: 'low', name: 'Thinking: low', description: null },
          { value: 'medium', name: 'Thinking: medium', description: null },
          { value: 'high', name: 'Thinking: high', description: null },
          { value: 'xhigh', name: 'Thinking: xhigh', description: null }
        ]
      }
    ])
  } finally {
    // no global state to restore
  }
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: TEST_CWD,
    ...fakeSessionConfigSync(conn),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'beta', name: 'Beta' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId, reasoning: true }
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/beta'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }
  }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: TEST_CWD,
    ...fakeSessionConfigSync(conn),
    proc: {
      async getAvailableModels() {
        return {
          models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
        }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'xhigh'
  } as any)

  assert.deepEqual(thinkingLevels, ['xhigh'])
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'xhigh')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'xhigh'
      }
    },
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: setSessionConfigOption rejects thinking levels the current model does not support', async () => {
  const conn = new FakeAgentSideConnection()
  const thinkingLevels: string[] = []
  const session = {
    sessionId: 's1',
    cwd: TEST_CWD,
    ...fakeSessionConfigSync(conn),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return {
          thinkingLevel: 'medium',
          model: { provider: 'test', id: 'alpha', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }
        }
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'max' } as any),
    (e: any) => {
      assert.equal(e?.code, -32602)
      assert.match(String(e?.message), /not supported by the current model/)
      return true
    }
  )
  await assert.rejects(
    () => agent.setSessionMode({ sessionId: 's1', modeId: 'max' } as any),
    (e: any) => e?.code === -32602
  )
  assert.deepEqual(thinkingLevels, [], 'unsupported levels must be rejected before reaching pi')
})

test('PiAcpAgent: setSessionConfigOption accepts max on a Kimi-like max-only model', async () => {
  const conn = new FakeAgentSideConnection()
  const thinkingLevels: string[] = []
  const state = {
    thinkingLevel: 'max',
    model: {
      provider: 'kimi',
      id: 'k3',
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max' }
    }
  }
  const session = {
    sessionId: 's1',
    cwd: TEST_CWD,
    ...fakeSessionConfigSync(conn),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'kimi', id: 'k3', name: 'K3' }] }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'max' } as any)

  assert.deepEqual(thinkingLevels, ['max'])
  const thought = result.configOptions.find(option => option.id === 'thought_level')
  assert.equal(thought?.currentValue, 'max')
  assert.deepEqual(
    (thought as any)?.options.map((o: any) => o.value),
    ['max'],
    'only the model-supported levels are advertised'
  )
})

test('PiAcpAgent: model switch refreshes advertised thinking levels for the new model', async () => {
  const conn = new FakeAgentSideConnection()
  const state: any = {
    thinkingLevel: 'high',
    model: { provider: 'test', id: 'plain', reasoning: true }
  }
  const session = {
    sessionId: 's1',
    cwd: TEST_CWD,
    ...fakeSessionConfigSync(conn),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'plain', name: 'Plain' },
            { provider: 'test', id: 'deep', name: 'Deep' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        state.model = {
          provider,
          id: modelId,
          reasoning: true,
          thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }
        }
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/deep' } as any)
  const thought = result.configOptions.find(option => option.id === 'thought_level')
  assert.deepEqual(
    (thought as any)?.options.map((o: any) => o.value),
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'config refresh after a model change includes the new model levels (incl. max)'
  )
})
