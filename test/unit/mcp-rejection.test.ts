import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const MCP_SERVER = { name: 'github', command: 'github-mcp-server', args: ['stdio'] }

function isMcpRejection(e: unknown): boolean {
  const err = e as { code?: number; message?: string; data?: { reason?: string } }
  assert.equal(err?.code, -32602)
  assert.equal(err?.data?.reason, 'MCP_SERVERS_UNSUPPORTED')
  assert.match(String(err?.message), /does not support MCP servers/)
  assert.match(String(err?.message), /Remove mcpServers/)
  return true
}

test('PiAcpAgent: newSession rejects non-empty mcpServers before creating any session', async () => {
  const createCalls: unknown[] = []
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = {
    async create(params: unknown) {
      createCalls.push(params)
      throw new Error('unreachable')
    }
  }

  await assert.rejects(agent.newSession({ cwd: process.cwd(), mcpServers: [MCP_SERVER] } as any), isMcpRejection)
  assert.equal(createCalls.length, 0, 'no pi subprocess may be spawned for a rejected request')
})

test('PiAcpAgent: loadSession rejects non-empty mcpServers before any session lookup or restore', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  // An unknown sessionId would raise resourceNotFound; invalidParams proves
  // the MCP validation runs before any side effect or lookup.
  await assert.rejects(
    agent.loadSession({
      sessionId: 'does-not-exist',
      cwd: process.cwd(),
      mcpServers: [MCP_SERVER]
    } as any),
    isMcpRejection
  )
})

test('PiAcpAgent: resumeSession rejects non-empty mcpServers before any session lookup or restore', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await assert.rejects(
    agent.resumeSession({
      sessionId: 'does-not-exist',
      cwd: process.cwd(),
      mcpServers: [MCP_SERVER]
    } as any),
    isMcpRejection
  )
})

test('PiAcpAgent: empty mcpServers pass validation without reaching startup work', async () => {
  const sentinel = new Error('validation passed')
  let createCalls = 0
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = {
    async create() {
      createCalls += 1
      throw sentinel
    }
  }

  await assert.rejects(agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any), error => error === sentinel)
  assert.equal(createCalls, 1, 'an empty list must pass MCP validation and reach session creation')
})
