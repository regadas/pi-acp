import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

test('PiAcpAgent: the thought_level config option rejects unknown levels for active sessions', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  manager.getOrCreate('active', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 'active', configId: 'thought_level', value: 'invalid' }),
    /unknown thinking level/i
  )
  assert.deepEqual(proc.thinkingLevels, [], 'an invalid level must never reach pi')
  assert.deepEqual(conn.updates, [])
})

test('PiAcpAgent: invalid thought_level values preserve typed not-found errors for unknown sessions', async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-thinking-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-thinking-store-'))

  try {
    const conn = new FakeConn()
    const agent = new PiAcpAgent(conn as any)

    await assert.rejects(
      () => agent.setSessionConfigOption({ sessionId: 'nope', configId: 'thought_level', value: 'invalid' }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError)
        assert.equal(error.code, -32002)
        assert.deepEqual(error.data, { uri: 'nope' })
        return true
      }
    )
    assert.deepEqual(conn.updates, [], 'an unknown session must not publish configuration updates')
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})
