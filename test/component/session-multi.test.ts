import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('SessionManager: independent sessions stay active side by side until explicitly closed', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager

  const procA = new FakePiRpcProcess()
  const procB = new FakePiRpcProcess()

  const a = manager.getOrCreate('session-a', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: procA as any,
    fileCommands: []
  })
  const b = manager.getOrCreate('session-b', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: procB as any,
    fileCommands: []
  })

  // The single-live-subprocess policy is gone for good.
  assert.equal((manager as any).closeAllExcept, undefined)

  const promptA = a.prompt('work for a')
  const promptB = b.prompt('work for b')

  // Both sessions run concurrently against their own pi subprocess.
  assert.equal(procA.prompts.length, 1)
  assert.equal(procB.prompts.length, 1)

  // Settling one session does not settle or disturb the other.
  procB.emit({ type: 'agent_start' })
  procB.emit({ type: 'agent_settled' })
  assert.equal(await promptB, 'end_turn')

  procA.emit({ type: 'agent_start' })
  procA.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a says hi' } })
  procA.emit({ type: 'agent_settled' })
  assert.equal(await promptA, 'end_turn')

  // ACP session/close frees only the requested session's subprocess.
  await agent.closeSession({ sessionId: 'session-a' })
  assert.equal(procA.disposeCount, 1)
  assert.equal(procB.disposeCount, 0)
  assert.equal(manager.maybeGet('session-a'), undefined)
  assert.equal(manager.maybeGet('session-b'), b)

  await agent.closeSession({ sessionId: 'session-b' })
  assert.equal(procB.disposeCount, 1)
})
