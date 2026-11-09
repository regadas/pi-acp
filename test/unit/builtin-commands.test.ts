import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { encodeTitleWidget, TITLE_WIDGET } from '../../src/acp/session-title.js'
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
    proc: proc as any,
    conn: asAgentConn(conn)
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

test('PiAcpAgent: /name and /compact preserve the raw free-text remainder', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const named: string[] = []
  proc.setSessionName = async (name: string) => {
    named.push(name)
  }
  const compacted: Array<string | undefined> = []
  proc.compact = async (instructions?: string) => {
    compacted.push(instructions)
    return { tokensBefore: 42 }
  }
  const steering: string[] = []
  proc.getState = async () => ({ steeringMode: 'all' })
  proc.setSteeringMode = async (mode: string) => {
    steering.push(mode)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const prompt = (text: string) => agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text }] } as any)

  assert.equal((await prompt(`/name Bob's "quick" refactor`)).stopReason, 'end_turn')
  assert.deepEqual(named, [`Bob's "quick" refactor`], 'apostrophes and quotes survive the raw remainder')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, `Bob's "quick" refactor`)
  assert.match(lastAgentMessageText(conn), /Session name set: Bob's "quick" refactor/)

  assert.equal((await prompt(`/name double  spaced`)).stopReason, 'end_turn')
  assert.deepEqual(named, [`Bob's "quick" refactor`, 'double  spaced'], 'inner spacing survives the raw remainder')

  assert.equal((await prompt(`/compact don't drop "API v2" notes`)).stopReason, 'end_turn')
  assert.deepEqual(compacted, [`don't drop "API v2" notes`], 'compaction instructions reach pi verbatim')
  assert.match(lastAgentMessageText(conn), /Compaction completed\. \(custom instructions applied\)/)
  assert.match(lastAgentMessageText(conn), /Tokens before: 42/)

  // Token-consuming commands keep the parsed-argument behavior.
  assert.equal((await prompt('/steering one-at-a-time')).stopReason, 'end_turn')
  assert.deepEqual(steering, ['one-at-a-time'])
  assert.equal(proc.prompts.length, 0, 'adapter commands never reach pi as prompts')
})

test('PiAcpAgent: /name outranks a title the extension generates afterwards', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    names.push(name)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/name Mine' }] } as any)

  // The extension's settled title arrives after the user's rename.
  proc.emit({
    type: 'extension_ui_request',
    id: 'title',
    method: 'setWidget',
    widgetKey: TITLE_WIDGET,
    widgetLines: encodeTitleWidget('Generated')
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  const shown = conn.updates
    .map(update => (update as any).update)
    .filter(update => update?.sessionUpdate === 'session_info_update' && 'title' in update)
    .map(update => update.title)
  assert.deepEqual(shown, ['Mine'], 'the generated title never replaces an explicit name')
  assert.deepEqual(names, ['Mine'], 'and never renames the pi session')
})

test('PiAcpAgent: a failed /name keeps a name the user set earlier', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const names: string[] = []
  proc.setSessionName = async (name: string) => {
    if (names.length === 1) throw new Error('set_session_name failed')
    names.push(name)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  // The first rename sticks; the second fails. The earlier name must still
  // outrank a generated title, so the failed attempt restores the latch.
  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/name First Name' }] } as any)
  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/name Second Attempt' }] } as any)

  proc.emit({
    type: 'extension_ui_request',
    id: 'title',
    method: 'setWidget',
    widgetKey: TITLE_WIDGET,
    widgetLines: encodeTitleWidget('Generated Title')
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  const shown = conn.updates
    .map(update => (update as any).update)
    .filter(update => update?.sessionUpdate === 'session_info_update' && 'title' in update)
    .map(update => update.title)
  assert.deepEqual(shown, ['First Name'], 'the earlier name still outranks a generated title')
  assert.deepEqual(names, ['First Name'], 'and the failed rename never reached pi')
})

test('PiAcpAgent: a failed /name leaves the session open to a generated title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.setSessionName = async () => {
    throw new Error('unknown command: set_session_name')
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const res = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/name Mine' }] } as any)
  assert.equal(res.stopReason, 'end_turn')
  assert.match(lastAgentMessageText(conn), /Failed to set session name/)

  // No name was set, so the generated title is still allowed to name the thread.
  proc.emit({
    type: 'extension_ui_request',
    id: 'title',
    method: 'setWidget',
    widgetKey: TITLE_WIDGET,
    widgetLines: encodeTitleWidget('Generated')
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  const shown = conn.updates
    .map(update => (update as any).update)
    .filter(update => update?.sessionUpdate === 'session_info_update' && 'title' in update)
    .map(update => update.title)
  assert.deepEqual(shown, ['Generated'], 'a rejected rename does not block titles forever')
})
