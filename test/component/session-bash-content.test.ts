import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-bash-content-cwd-'))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const interleavedBashResult = {
  content: [
    { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
    { type: 'text', text: 'between the images\n' },
    { type: 'image', data: 'aW1nQg==', mimeType: 'image/jpeg' }
  ],
  details: { exitCode: 0 }
}

const expectedOrderedContent = [
  { type: 'content', content: { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' } },
  { type: 'content', content: { type: 'text', text: '```console\nbetween the images\n```' } },
  { type: 'content', content: { type: 'image', data: 'aW1nQg==', mimeType: 'image/jpeg' } }
]

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess, supportsTerminalOutputMeta: boolean) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutputMeta
  })
}

test('PiAcpSession: live generic bash results keep interleaved text/image source order', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, false)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'render' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'b1', isError: false, result: interleavedBashResult })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const end = conn.updates
    .map(u => (u as any).update)
    .find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1' && u.status === 'completed')
  assert.ok(end, 'expected the completed bash update')
  assert.deepEqual(end.content, expectedOrderedContent, 'image,text,image must stay in source order')
  assert.equal(end._meta, undefined, 'no terminal metadata for generic clients')
})

test('PiAcpSession: live generic bash output preserves whitespace and uses a safe fence', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, false)
  const output = 'value  \n\n``````\nend \n'

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'render' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    isError: false,
    result: { content: [{ type: 'text', text: output }], details: { exitCode: 0 } }
  })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const end = conn.updates
    .map(u => (u as any).update)
    .find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1' && u.status === 'completed')
  assert.deepEqual(end.content, [
    {
      type: 'content',
      content: { type: 'text', text: '```````console\nvalue  \n\n``````\nend \n```````' }
    }
  ])
  assert.equal(end._meta, undefined)
})

test('PiAcpSession: live generic bash results fall back to details output only without content text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, false)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'render' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    isError: false,
    result: {
      content: [{ type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' }],
      details: { stdout: 'stdout only\n', exitCode: 0 }
    }
  })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const end = conn.updates
    .map(u => (u as any).update)
    .find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1' && u.status === 'completed')
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: '```console\nstdout only\n```' } },
    { type: 'content', content: { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' } }
  ])
})

test('PiAcpSession: negotiated bash results retain every image as standard content beside the terminal ref', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, true)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'render' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'b1', isError: false, result: interleavedBashResult })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const end = conn.updates
    .map(u => (u as any).update)
    .find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1' && u.status === 'completed')
  assert.deepEqual(end.content, [
    { type: 'terminal', terminalId: 'b1' },
    { type: 'content', content: { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' } },
    { type: 'content', content: { type: 'image', data: 'aW1nQg==', mimeType: 'image/jpeg' } }
  ])
  assert.deepEqual(end._meta.terminal_output, { terminal_id: 'b1', data: 'between the images\n' })
  assert.deepEqual(end._meta.terminal_exit, { terminal_id: 'b1', exit_code: 0, signal: null })
})

test('PiAcpAgent: load replay keeps interleaved generic bash content in source order', async () => {
  const snapshot = {
    entries: [
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_bash',
          toolName: 'bash',
          args: { command: 'render' },
          ...interleavedBashResult,
          isError: false
        }
      }
    ],
    leafId: 'e1'
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      onTermination: () => () => {},
      whenTerminated: async () => {},
      getEntries: async (beforeResponseResolve?: () => void) => {
        beforeResponseResolve?.()
        return snapshot
      },
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium', sessionId: 's1', sessionFile: '/tmp/s.jsonl' })
    }) as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => ({ sessionId: 's1', cwd: TEST_CWD, sessionFile: '/tmp/s.jsonl', updatedAt: 'x' }),
      upsert: () => {}
    }
    ;(agent as any).scheduleDeferred = () => {}

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })

    const end = conn.updates
      .map(u => (u as any).update)
      .find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_bash')
    assert.ok(end, 'expected replayed bash tool_call_update')
    assert.equal(end.status, 'completed')
    assert.deepEqual(end.content, expectedOrderedContent, 'replayed image,text,image must stay in source order')
    assert.equal(end._meta, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
