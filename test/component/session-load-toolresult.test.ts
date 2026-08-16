import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-load-toolresult-cwd-'))

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: TEST_CWD, sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

const bashResultTree = {
  tree: [
    {
      entry: {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          args: { command: 'echo hello' },
          content: [{ type: 'text', text: 'hello from bash' }],
          isError: false
        }
      },
      children: []
    }
  ],
  leafId: 'e1'
}

function mockSpawn(tree: unknown) {
  return async () =>
    ({
      onEvent: () => () => {},
      onTermination: () => () => {},
      whenTerminated: async () => {},
      getTree: async (beforeResponseResolve?: () => void) => {
        beforeResponseResolve?.()
        return tree
      },
      getAvailableModels: async () => ({ models: [] }),
      // Restore validation requires pi to report the requested session.
      getState: async () => ({ thinkingLevel: 'medium', sessionId: 's1', sessionFile: '/tmp/s.jsonl' })
    }) as any
}

test('PiAcpAgent: loadSession replays toolResult with negotiated Zed terminal metadata', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(bashResultTree)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { _meta: { terminal_output: true } }
    } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.status, 'in_progress')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: TEST_CWD } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays bash output as standard content without negotiation', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(bashResultTree)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.status, 'in_progress')
    assert.equal(toolCall.content, undefined, 'no fabricated terminal reference for generic clients')
    assert.equal(toolCall._meta, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.status, 'completed')
    assert.equal(toolCallUpdate._meta, undefined, 'no terminal_* metadata for generic clients')
    assert.deepEqual(toolCallUpdate.content, [
      { type: 'content', content: { type: 'text', text: '```console\nhello from bash\n```' } }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

const bashImageResultTree = {
  tree: [
    {
      entry: {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_img',
          toolName: 'bash',
          args: { command: 'render' },
          content: [{ type: 'image', data: 'YmFzaA==', mimeType: 'image/png' }],
          details: { stdout: 'rendered chart\n', exitCode: 0 },
          isError: false
        }
      },
      children: []
    }
  ],
  leafId: 'e1'
}

test('PiAcpAgent: loadSession retains bash image blocks alongside negotiated terminal metadata', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(bashImageResultTree)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { _meta: { terminal_output: true } }
    } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const updates = conn.updates.map(u => (u as any).update)
    const end = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_img')
    assert.ok(end)
    assert.equal(end.status, 'completed')
    assert.deepEqual(end._meta, {
      terminal_output: { terminal_id: 'call_img', data: 'rendered chart\n' },
      terminal_exit: { terminal_id: 'call_img', exit_code: 0, signal: null }
    })
    assert.deepEqual(end.content, [
      { type: 'terminal', terminalId: 'call_img' },
      { type: 'content', content: { type: 'image', data: 'YmFzaA==', mimeType: 'image/png' } }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession retains bash image blocks as standard content for generic clients', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(bashImageResultTree)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const updates = conn.updates.map(u => (u as any).update)
    const end = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_img')
    assert.ok(end)
    assert.equal(end.status, 'completed')
    assert.equal(end._meta, undefined)
    assert.deepEqual(end.content, [
      { type: 'content', content: { type: 'text', text: '```console\nrendered chart\n```' } },
      { type: 'content', content: { type: 'image', data: 'YmFzaA==', mimeType: 'image/png' } }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession keeps failed replayed tools monotonic (never completed then failed)', async () => {
  const failedTree = {
    tree: [
      {
        entry: {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: '2026-02-11T00:00:01.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call_err',
            toolName: 'read',
            content: [{ type: 'text', text: 'no such file' }],
            isError: true
          }
        },
        children: []
      }
    ],
    leafId: 'e1'
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(failedTree)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const statuses = conn.updates
      .map(u => (u as any).update)
      .filter(u => u?.toolCallId === 'call_err')
      .map(u => u.status)
    assert.deepEqual(statuses, ['in_progress', 'failed'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
