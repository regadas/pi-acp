import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

test('PiAcpAgent: setSessionMode rejects invalid modes for active sessions', async () => {
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

  await assert.rejects(() => agent.setSessionMode({ sessionId: 'active', modeId: 'invalid' } as any), /unknown modeId/i)
})

test('PiAcpAgent: setSessionMode rejects unknown sessions with a typed not-found error', async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-thinking-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-thinking-store-'))

  try {
    const conn = new FakeConn()
    const agent = new PiAcpAgent(conn as any)

    await assert.rejects(
      () => agent.setSessionMode({ sessionId: 'nope', modeId: 'invalid' } as any),
      /resource not found/i
    )
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})
