import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn, lastAgentMessageText } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.match(lastAgentMessageText(conn), /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /autocompact rejects an unknown argument without mutating the setting', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const effects: string[] = []
  proc.getState = async () => {
    effects.push('state')
    return { autoCompactionEnabled: false }
  }
  const getAvailableModels = proc.getAvailableModels.bind(proc)
  proc.getAvailableModels = async () => {
    effects.push('models')
    return getAvailableModels()
  }
  const applied: boolean[] = []
  proc.setAutoCompaction = async (enabled: boolean) => {
    effects.push(`set:${enabled}`)
    applied.push(enabled)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/autocompact onn' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.deepEqual(applied, [], 'a typo must never flip the setting')
  assert.deepEqual(effects, ['state', 'models'], 'only completion reconciliation reads state; no toggle mutation')
  assert.match(lastAgentMessageText(conn), /Unknown argument: onn\. Usage: \/autocompact on \| off \| toggle/)
})

test('PiAcpAgent: /autocompact applies explicit aliases and toggles the current state', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const effects: string[] = []
  proc.getState = async () => {
    effects.push('state')
    return { autoCompactionEnabled: true }
  }
  const getAvailableModels = proc.getAvailableModels.bind(proc)
  proc.getAvailableModels = async () => {
    effects.push('models')
    return getAvailableModels()
  }
  const applied: boolean[] = []
  proc.setAutoCompaction = async (enabled: boolean) => {
    effects.push(`set:${enabled}`)
    applied.push(enabled)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const prompt = (text: string) => agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text }] } as any)

  assert.equal((await prompt('/autocompact disabled')).stopReason, 'end_turn')
  assert.equal((await prompt('/autocompact ENABLE')).stopReason, 'end_turn')
  assert.deepEqual(
    effects,
    ['set:false', 'state', 'models', 'set:true', 'state', 'models'],
    'aliases mutate before the completion metadata probes'
  )

  assert.equal((await prompt('/autocompact')).stopReason, 'end_turn')
  assert.deepEqual(
    effects.slice(6),
    ['state', 'set:false', 'state', 'models'],
    'the bare toggle reads state before mutation, then reconciles configuration'
  )

  assert.deepEqual(applied, [false, true, false])
})

test('PiAcpAgent: /model, /thinking and /clear are guidance-only and never reach pi as prompts', async () => {
  const guidance: Record<string, RegExp> = {
    model:
      /Model selection is owned by your ACP client's session settings \(the standard "model" session config option\)/,
    thinking:
      /Thinking level is owned by your ACP client's session settings \(the standard "thought_level" session config option\)/,
    clear: /\/clear is not implemented\. Start a new session from your ACP client instead\./
  }
  for (const [cmd, pattern] of Object.entries(guidance)) {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess() as any
    const session = makeSession(conn, proc)
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = new FakeSessions(session) as any
    try {
      const res = agent.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: `/${cmd} ignored argument` }]
      } as any)
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(proc.prompts.length, 0, `/${cmd} must be answered locally, not sent to pi as a raw prompt`)
      proc.emit({ type: 'agent_start' })
      proc.emit({ type: 'agent_settled' })
      assert.equal((await res).stopReason, 'end_turn')
      assert.match(lastAgentMessageText(conn), pattern)
    } finally {
      session.dispose()
    }
  }
})

test('PiAcpAgent: a slash command outside the builtin inventory still routes to pi verbatim', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = makeSession(conn, proc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  try {
    const res = agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: '/pi-extension-template arg' }]
    } as any)
    await new Promise(resolve => setTimeout(resolve, 0))
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.equal((await res).stopReason, 'end_turn')
    assert.deepEqual(
      proc.prompts.map((item: { message: string }) => item.message),
      ['/pi-extension-template arg'],
      'pi-owned commands keep their raw prompt routing for template/extension expansion'
    )
  } finally {
    session.dispose()
  }
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  assert.match(lastAgentMessageText(conn), /Session name set: My Session/)
})
