import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

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
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

function makeAgent(session: any) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any
  return { agent, conn }
}

test('setSessionConfigOption: fails closed when thinking-level support cannot be established', async () => {
  const thinkingLevels: string[] = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        throw new Error('get_state broke')
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
      }
    }
  }
  const { agent, conn } = makeAgent(session)

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'medium' } as any),
    (e: any) => {
      assert.equal(e?.code, -32603)
      assert.match(String(e?.message), /Cannot verify thinking level support/)
      return true
    }
  )
  assert.deepEqual(thinkingLevels, [], 'no write may be issued without an established support set')
  assert.deepEqual(conn.updates, [], 'no success updates may be published for a failed write')
})

test('setSessionConfigOption: rejects when the post-write probe fails after set_thinking_level', async () => {
  let stateCalls = 0
  const thinkingLevels: string[] = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        stateCalls += 1
        if (stateCalls > 1) throw new Error('post-write probe failed')
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha', reasoning: true } }
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
      }
    }
  }
  const { agent, conn } = makeAgent(session)

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any),
    (e: any) => {
      assert.equal(e?.code, -32603)
      assert.match(String(e?.message), /Could not verify the thinking level/)
      return true
    }
  )
  assert.deepEqual(thinkingLevels, ['high'])
  assert.deepEqual(conn.updates, [], 'an unverified write must not publish current_mode/config updates')
})

test('setSessionConfigOption: rejects when pi clamps the requested thinking level', async () => {
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        // pi silently keeps clamping to medium regardless of the write.
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha', reasoning: true } }
      },
      async setThinkingLevel(_level: string) {}
    }
  }
  const { agent, conn } = makeAgent(session)

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any),
    (e: any) => {
      assert.equal(e?.code, -32603)
      assert.match(String(e?.message), /did not apply thinking level high/)
      return true
    }
  )
  assert.deepEqual(conn.updates, [])
})

test('setSessionMode: rejects clamped writes through the same verified path', async () => {
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha', reasoning: true } }
      },
      async setThinkingLevel(_level: string) {}
    }
  }
  const { agent, conn } = makeAgent(session)

  await assert.rejects(
    () => agent.setSessionMode({ sessionId: 's1', modeId: 'high' } as any),
    (e: any) => e?.code === -32603 && /did not apply thinking level/.test(String(e?.message))
  )
  assert.deepEqual(conn.updates, [])
})

test('setSessionConfigOption: rejects when pi does not apply the requested model', async () => {
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
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
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha', reasoning: true } }
      },
      async setModel(_provider: string, _modelId: string) {
        // pi keeps the old model (e.g. rejected/clamped switch).
      }
    }
  }
  const { agent, conn } = makeAgent(session)

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/beta' } as any),
    (e: any) => {
      assert.equal(e?.code, -32603)
      assert.match(String(e?.message), /did not apply model test\/beta/)
      return true
    }
  )
  assert.deepEqual(conn.updates, [])
})

test('setSessionConfigOption: serializes concurrent mutations (write then verify before the next write)', async () => {
  const ops: string[] = []
  let releaseFirstSet!: () => void
  const firstSetGate = new Promise<void>(resolve => {
    releaseFirstSet = resolve
  })
  let setCalls = 0

  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        ops.push(`get_state:${state.thinkingLevel}`)
        return { ...state }
      },
      async setThinkingLevel(level: string) {
        setCalls += 1
        ops.push(`set:${level}`)
        if (setCalls === 1) await firstSetGate
        state.thinkingLevel = level
      }
    }
  }
  const { agent } = makeAgent(session)

  const first = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any)
  const second = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'low' } as any)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(
    ops.filter(op => op.startsWith('set:')),
    ['set:high'],
    'the second write must wait for the first mutation to finish'
  )

  releaseFirstSet()
  await Promise.all([first, second])

  const setAndVerify = ops.filter(op => op.startsWith('set:') || op.startsWith('get_state:'))
  const firstVerifyIndex = setAndVerify.indexOf('get_state:high')
  const secondSetIndex = setAndVerify.indexOf('set:low')
  assert.ok(
    firstVerifyIndex >= 0 && secondSetIndex > firstVerifyIndex,
    `unexpected op order: ${setAndVerify.join(', ')}`
  )
  assert.equal(state.thinkingLevel, 'low')
})

test('newSession: unknown model state advertises only the conservative off level with a valid currentValue', async () => {
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return { thinkingLevel: 'medium' }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
  const { agent } = makeAgent(session)
  // Local seam: swallow deferred notifications instead of patching timers.
  ;(agent as any).scheduleDeferred = () => {}

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  const thought = result.configOptions.find(option => option.id === 'thought_level') as any
  assert.deepEqual(
    thought?.options.map((o: any) => o.value),
    ['off'],
    'no thinking level may be advertised blind'
  )
  assert.equal(thought?.currentValue, 'off', 'currentValue must be one of the advertised options')
  assert.equal(result.modes?.currentModeId, 'off')
})

test('newSession: non-reasoning models advertise only off with a valid currentValue', async () => {
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'plain', name: 'Plain' }] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'plain', reasoning: false } }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
  const { agent } = makeAgent(session)
  ;(agent as any).scheduleDeferred = () => {}

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  const thought = result.configOptions.find(option => option.id === 'thought_level') as any
  assert.deepEqual(
    thought?.options.map((o: any) => o.value),
    ['off']
  )
  assert.equal(thought?.currentValue, 'off')
})

test('config mutations serialize publication: a second write waits for the first mutation\u2019s updates', async () => {
  const ops: string[] = []
  let releaseFirstPublish!: () => void
  const firstPublishGate = new Promise<void>(resolve => {
    releaseFirstPublish = resolve
  })
  let publishCalls = 0

  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return { ...state }
      },
      async setThinkingLevel(level: string) {
        ops.push(`set:${level}`)
        state.thinkingLevel = level
      }
    }
  }
  const { agent, conn } = makeAgent(session)

  // Block the first mutation's publication (current_mode_update) so its
  // exclusive section is still open when the second mutation arrives.
  const deliver = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async update => {
    publishCalls += 1
    ops.push(`publish:${(update as any).update.sessionUpdate}`)
    if (publishCalls === 1) await firstPublishGate
    await deliver(update)
  }

  const first = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any)
  const second = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'low' } as any)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(
    ops.filter(op => op.startsWith('set:')),
    ['set:high'],
    'the second write must not apply while the first mutation\u2019s updates are undelivered'
  )

  releaseFirstPublish()
  await Promise.all([first, second])

  const relevant = ops.filter(op => op.startsWith('set:') || op.startsWith('publish:'))
  assert.deepEqual(
    relevant,
    [
      'set:high',
      'publish:current_mode_update',
      'publish:config_option_update',
      'set:low',
      'publish:current_mode_update',
      'publish:config_option_update'
    ],
    'publication is part of the exclusive mutation, so updates arrive in apply order'
  )
})
