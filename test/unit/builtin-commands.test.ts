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

  let stateReads = 0
  proc.getState = async () => {
    stateReads += 1
    return { autoCompactionEnabled: false }
  }
  const applied: boolean[] = []
  proc.setAutoCompaction = async (enabled: boolean) => {
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
  assert.equal(stateReads, 0, 'an unknown argument is not a toggle')
  assert.match(lastAgentMessageText(conn), /Unknown argument: onn\. Usage: \/autocompact on \| off \| toggle/)
})

test('PiAcpAgent: /autocompact applies explicit aliases and toggles the current state', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let stateReads = 0
  proc.getState = async () => {
    stateReads += 1
    return { autoCompactionEnabled: true }
  }
  const applied: boolean[] = []
  proc.setAutoCompaction = async (enabled: boolean) => {
    applied.push(enabled)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(makeSession(conn, proc)) as any

  const prompt = (text: string) => agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text }] } as any)

  assert.equal((await prompt('/autocompact disabled')).stopReason, 'end_turn')
  assert.equal((await prompt('/autocompact ENABLE')).stopReason, 'end_turn')
  assert.equal(stateReads, 0, 'explicit aliases never need pi state')

  assert.equal((await prompt('/autocompact')).stopReason, 'end_turn')
  assert.equal(stateReads, 1, 'only the bare toggle reads pi state')

  assert.deepEqual(applied, [false, true, false])
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
