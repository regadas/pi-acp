import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcRequestTimeoutError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: an adapter command timeout evicts the quarantined session', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // /compact times out: the RPC layer quarantines the channel and rejects.
  ;(proc as any).compact = async () => {
    throw new PiRpcRequestTimeoutError('compact', 10)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-compact-timeout'
  const session = manager.getOrCreate(sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  await assert.rejects(
    () => agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/compact' }] } as any),
    (e: unknown) => e instanceof PiRpcRequestTimeoutError
  )

  assert.equal(session.isUnavailable(), true, 'the session is marked unavailable')
  assert.ok(proc.disposeCount >= 1, 'the quarantined process was disposed')
  assert.equal(manager.maybeGet(sessionId), undefined, 'the dead session was evicted for a fresh restore')
})
