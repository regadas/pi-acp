import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-session-events-cwd-'))

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits visible custom messages in-turn and omits hidden custom messages', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('test prompt')
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      display: true,
      content: [
        { type: 'text', text: 'Background task ' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'completed.' }
      ]
    }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: false, content: 'Hidden custom message' }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', content: 'Display flag absent' }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: [] }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Already streamed' }] }
  })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const agentChunks = conn.updates
    .map(update => update.update)
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
  assert.equal(agentChunks.length, 1)
  assert.deepEqual(agentChunks[0], {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Background task completed.' }
  })
})

test('PiAcpSession: buffers out-of-turn custom messages until the next prompt exactly once', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const agentMessageTexts = () =>
    conn.updates
      .map(update => update.update)
      .filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update as any).content.text)

  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'First idle message.' }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'Second idle message.' }
  })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(agentMessageTexts(), [])

  const firstPrompt = session.prompt('first prompt')
  proc.emit({ type: 'agent_settled' })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'After completion started.' }
  })
  assert.equal(await firstPrompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(agentMessageTexts(), ['First idle message.', 'Second idle message.'])

  const secondPrompt = session.prompt('second prompt')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await secondPrompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(agentMessageTexts(), ['First idle message.', 'Second idle message.', 'After completion started.'])

  const thirdPrompt = session.prompt('third prompt')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await thirdPrompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(agentMessageTexts(), ['First idle message.', 'Second idle message.', 'After completion started.'])
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: synchronizes session info and thinking configuration events without duplicate updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'high',
    model: { provider: 'test', id: 'model', reasoning: true }
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'session_info_changed', name: 'Project session' })
  proc.emit({ type: 'session_info_changed', name: 'Project session' })
  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  await new Promise(r => setTimeout(r, 0))

  const infoUpdates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'session_info_update')
  assert.equal(infoUpdates.length, 1)
  assert.equal(infoUpdates[0]?.title, 'Project session')
  assert.equal(typeof infoUpdates[0]?.updatedAt, 'string')

  const legacyModeUpdates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'current_mode_update')
  assert.deepEqual(legacyModeUpdates, [], 'thinking levels are never published as legacy session modes')

  const configUpdates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'config_option_update')
  assert.equal(configUpdates.length, 1)
  assert.deepEqual(
    configUpdates[0]?.configOptions.map(option => [option.id, option.currentValue]),
    [
      ['model', 'test/model'],
      ['thought_level', 'high']
    ]
  )

  proc.emit({ type: 'session_info_changed', name: undefined })
  proc.emit({ type: 'session_info_changed', name: undefined })
  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  await new Promise(r => setTimeout(r, 0))

  const finalInfoUpdates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'session_info_update')
  assert.equal(finalInfoUpdates.length, 2)
  assert.equal(finalInfoUpdates[1]?.title, null)
  assert.equal(
    conn.updates.filter(notification => notification.update.sessionUpdate === 'config_option_update').length,
    1
  )
})

test('PiAcpSession: coalesces thinking events produced by ACP configuration mutations', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'high',
    model: { provider: 'test', id: 'model', reasoning: true }
  }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  await new Promise(r => setTimeout(r, 0))
  const initialConfigUpdate = conn.updates
    .map(notification => notification.update)
    .find(update => update.sessionUpdate === 'config_option_update')
  assert.ok(initialConfigUpdate)
  conn.updates.length = 0

  const lowConfigOptions = initialConfigUpdate.configOptions.map(option =>
    option.id === 'thought_level' && option.type === 'select' ? { ...option, currentValue: 'low' } : option
  )
  session.beginConfigurationMutation()
  proc.state = { ...proc.state, thinkingLevel: 'low' }
  proc.emit({ type: 'thinking_level_changed', level: 'low' })
  await session.sendSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'config_option_update', configOptions: lowConfigOptions }
  })
  session.seedSessionConfiguration(lowConfigOptions)
  await session.endConfigurationMutation()

  assert.deepEqual(
    conn.updates.map(notification => notification.update.sessionUpdate),
    ['config_option_update']
  )
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    // This test locks in the negotiated Zed terminal_output convention.
    supportsTerminalOutputMeta: true
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: TEST_CWD }
  })
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[1]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[1]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'running' }
  })
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.equal((conn.updates[2]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[2]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'done' },
    terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null }
  })
  assert.equal((conn.updates[2]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: synthesizes starts before prompt-owned completion-only tool events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutputMeta: true
  })

  const prompt = session.prompt('run tools')
  proc.emit({ type: 'agent_start' })
  const readResult = { content: [{ type: 'text', text: 'file contents' }] }
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'missing-read-start',
    toolName: 'read',
    isError: false,
    result: readResult
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'missing-bash-start',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
  assert.deepEqual(updates, [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'missing-read-start',
      title: 'read',
      kind: 'read',
      status: 'in_progress'
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'missing-read-start',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
      rawOutput: readResult
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'missing-bash-start',
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      locations: undefined,
      content: [{ type: 'terminal', terminalId: 'missing-bash-start' }],
      _meta: { terminal_info: { terminal_id: 'missing-bash-start', cwd: TEST_CWD } }
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'missing-bash-start',
      status: 'completed',
      _meta: {
        terminal_output: { terminal_id: 'missing-bash-start', data: 'done' },
        terminal_exit: { terminal_id: 'missing-bash-start', exit_code: 0, signal: null }
      }
    }
  ])
})

test('PiAcpSession: synthesizes starts for progress-only tool events and keeps subagent partials hidden', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutputMeta: true
  })

  const prompt = session.prompt('run tools')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'missing-read-start',
    toolName: 'read',
    args: { path: 'notes.md' },
    partialResult: { content: [{ type: 'text', text: 'partial' }] }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'missing-bash-start',
    toolName: 'bash',
    args: { command: 'ls' },
    partialResult: { content: [{ type: 'text', text: 'streaming' }] }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'missing-subagent-start',
    toolName: 'subagent',
    args: { prompt: 'investigate' },
    partialResult: { content: [{ type: 'text', text: 'inner reasoning' }] }
  })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
  assert.deepEqual(updates, [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'missing-read-start',
      title: 'read',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'notes.md' }
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'missing-read-start',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
      rawOutput: { content: [{ type: 'text', text: 'partial' }] }
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'missing-bash-start',
      title: 'ls',
      kind: 'execute',
      status: 'in_progress',
      locations: undefined,
      content: [{ type: 'terminal', terminalId: 'missing-bash-start' }],
      _meta: { terminal_info: { terminal_id: 'missing-bash-start', cwd: TEST_CWD } }
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'missing-bash-start',
      status: 'in_progress',
      _meta: { terminal_output: { terminal_id: 'missing-bash-start', data: 'streaming' } }
    },
    {
      // The subagent's own transcript stays hidden, but the card still exists.
      sessionUpdate: 'tool_call',
      toolCallId: 'missing-subagent-start',
      title: 'subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: { prompt: 'investigate' }
    }
  ])
})

test('PiAcpSession: a duplicate tool_execution_end does not resurrect a completed tool call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('run tools')
  proc.emit({ type: 'agent_start' })
  const end = {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'read',
    isError: false,
    result: { content: [{ type: 'text', text: 'file contents' }] }
  }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'notes.md' } })
  proc.emit(end)
  proc.emit(end)
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'call-1',
    toolName: 'read',
    partialResult: { content: [{ type: 'text', text: 'late partial' }] }
  })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const kinds = conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    .map(update => [update.sessionUpdate, (update as { status?: string }).status])
  assert.deepEqual(kinds, [
    ['tool_call', 'in_progress'],
    ['tool_call_update', 'completed']
  ])
})

test('PiAcpSession: bash output falls back to standard content without terminal_output negotiation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'running\ndone' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  const start = conn.updates[0]!.update as any
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.equal(start.kind, 'execute')
  assert.equal(start.content, undefined, 'no fabricated terminal reference for generic clients')
  assert.equal(start._meta, undefined)

  const progress = conn.updates[1]!.update as any
  assert.equal(progress.sessionUpdate, 'tool_call_update')
  assert.equal(progress.status, 'in_progress')
  assert.equal(progress._meta, undefined)
  assert.deepEqual(progress.content, [{ type: 'content', content: { type: 'text', text: '```console\nrunning\n```' } }])

  const end = conn.updates[2]!.update as any
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.status, 'completed')
  assert.equal(end._meta, undefined)
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: '```console\nrunning\ndone\n```' } }
  ])
})

test('PiAcpSession: suppresses cumulative subagent progress snapshots but preserves start and completion', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const args = { agent: 'worker', task: 'Implement the fix' }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'subagent-1', toolName: 'subagent', args })

  const messages: unknown[] = []
  for (let i = 0; i < 100; i += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(64) }] })
    proc.emit({
      type: 'tool_execution_update',
      toolCallId: 'subagent-1',
      partialResult: {
        content: [{ type: 'text', text: `(running ${i})` }],
        details: { mode: 'single', results: [{ messages: [...messages] }] }
      }
    })
  }

  const result = {
    content: [{ type: 'text', text: 'final report' }],
    details: { mode: 'single', results: [{ status: 'complete' }] }
  }
  proc.emit({ type: 'tool_execution_end', toolCallId: 'subagent-1', isError: false, result })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'tool_call',
    toolCallId: 'subagent-1',
    title: 'subagent',
    kind: 'other',
    status: 'in_progress',
    locations: undefined,
    rawInput: args
  })
  assert.deepEqual(conn.updates[1]!.update, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'subagent-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'final report' } }],
    rawOutput: result
  })
})

test('PiAcpSession: suppresses streamed subagent argument deltas but preserves boundary input and status', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const toolCallId = 'subagent-stream'
  const finalInput = { agent: 'worker', task: 'A complete delegated task' }
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: toolCallId, name: 'subagent', partialArgs: '' }
    }
  })
  for (let i = 0; i < 50; i += 1) {
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        toolCall: { id: toolCallId, name: 'subagent', partialArgs: `{"task":"${'x'.repeat(i)}` }
      }
    })
  }
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: { id: toolCallId, name: 'subagent', arguments: finalInput }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId, toolName: 'subagent', args: finalInput })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId,
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 4)
  assert.deepEqual(
    conn.updates.map(entry => [entry.update.sessionUpdate, (entry.update as any).status]),
    [
      ['tool_call', 'pending'],
      ['tool_call_update', 'pending'],
      ['tool_call_update', 'in_progress'],
      ['tool_call_update', 'completed']
    ]
  )
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)
  assert.deepEqual((conn.updates[1]!.update as any).rawInput, finalInput)
  assert.deepEqual((conn.updates[2]!.update as any).rawInput, finalInput)
})

test('PiAcpSession: preserves tool-result image content in live tool_call_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'screenshot', args: {} })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: {
      content: [
        { type: 'text', text: 'captured' },
        { type: 'image', data: 'aWFtYXBuZw==', mimeType: 'image/png' }
      ]
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.at(-1)!.update as any
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.status, 'completed')
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: 'captured' } },
    { type: 'content', content: { type: 'image', data: 'aWFtYXBuZw==', mimeType: 'image/png' } }
  ])
})

test('PiAcpSession: preserves interleaved and image-only tool-result order in live updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't-mixed', toolName: 'screenshot', args: {} })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-mixed',
    isError: false,
    result: {
      content: [
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'text', text: 'between' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' }
      ]
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't-img-only', toolName: 'screenshot', args: {} })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-img-only',
    isError: false,
    result: { content: [{ type: 'image', data: 'b25seQ==', mimeType: 'image/png' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any)
  const mixed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 't-mixed')
  assert.deepEqual(mixed.content, [
    { type: 'content', content: { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' } },
    { type: 'content', content: { type: 'text', text: 'between' } },
    { type: 'content', content: { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' } }
  ])

  const imageOnly = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 't-img-only')
  assert.deepEqual(
    imageOnly.content,
    [{ type: 'content', content: { type: 'image', data: 'b25seQ==', mimeType: 'image/png' } }],
    'an image-only result must not grow a JSON/base64 text block'
  )
})

test('PiAcpSession: emits custom-message image blocks in order during an active turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('test prompt')
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      display: true,
      content: [
        { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
        { type: 'text', text: 'annotated' }
      ]
    }
  })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const chunks = conn.updates
    .map(u => u.update as any)
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content)
  assert.deepEqual(chunks, [
    { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
    { type: 'text', text: 'annotated' }
  ])
})

test('PiAcpSession: flushes idle custom-message image blocks in order on the next prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      display: true,
      content: [
        { type: 'text', text: 'result: ' },
        { type: 'image', data: 'aW1nQg==', mimeType: 'image/jpeg' }
      ]
    }
  })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(
    conn.updates.map(u => (u.update as any).sessionUpdate).filter(kind => kind === 'agent_message_chunk'),
    [],
    'idle custom messages stay pending until a prompt turn'
  )

  const prompt = session.prompt('next prompt')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  const chunks = conn.updates
    .map(u => u.update as any)
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content)
  assert.deepEqual(chunks, [
    { type: 'text', text: 'result: ' },
    { type: 'image', data: 'aW1nQg==', mimeType: 'image/jpeg' }
  ])
})

test('PiAcpSession: retains bash tool-result image blocks for generic clients', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'render' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    isError: false,
    result: {
      content: [{ type: 'image', data: 'YmFzaA==', mimeType: 'image/png' }],
      details: { stdout: 'rendered chart\n', exitCode: 0 }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.at(-1)!.update as any
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.status, 'completed')
  assert.equal(end._meta, undefined)
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: '```console\nrendered chart\n```' } },
    { type: 'content', content: { type: 'image', data: 'YmFzaA==', mimeType: 'image/png' } }
  ])
})

test('PiAcpSession: retains bash tool-result image blocks alongside negotiated terminal metadata', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutputMeta: true
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'b2', toolName: 'bash', args: { command: 'render' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b2',
    isError: false,
    result: {
      content: [{ type: 'image', data: 'YmFzaA==', mimeType: 'image/png' }],
      details: { stdout: 'rendered chart\n', exitCode: 0 }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.at(-1)!.update as any
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.status, 'completed')
  assert.deepEqual(end._meta, {
    terminal_output: { terminal_id: 'b2', data: 'rendered chart\n' },
    terminal_exit: { terminal_id: 'b2', exit_code: 0, signal: null }
  })
  assert.deepEqual(end.content, [
    { type: 'terminal', terminalId: 'b2' },
    { type: 'content', content: { type: 'image', data: 'YmFzaA==', mimeType: 'image/png' } }
  ])
})

test('PiAcpSession: emits existing file locations for built-in and custom tools', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-file-location-'))
  mkdirSync(join(cwd, 'src', 'acp'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'acp', 'session.ts'), 'export {}\n', 'utf8')
  const args = { path: 'src/acp/session.ts' }

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'custom', toolName: 'ctx_execute_file', args })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: join(cwd, 'src', 'acp', 'session.ts') }])
  assert.deepEqual((conn.updates[1]!.update as any).locations, [{ path: join(cwd, 'src', 'acp', 'session.ts') }])
})

test('PiAcpSession: omits directory tool locations', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-directory-location-'))

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'ctx_index', args: { path: cwd } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
})

test('PiAcpSession: omits missing locations for non-write tools', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-missing-location-'))

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'read',
    args: { path: 'missing.txt' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
})

test(
  'PiAcpSession: follows symlinks only when they resolve to files',
  { skip: process.platform === 'win32' },
  async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-symlink-location-'))
    const filePath = join(cwd, 'target.txt')
    const directoryPath = join(cwd, 'directory')
    const fileLink = join(cwd, 'file-link')
    const directoryLink = join(cwd, 'directory-link')
    const brokenLink = join(cwd, 'broken-link')

    writeFileSync(filePath, 'content', 'utf8')
    mkdirSync(directoryPath)
    symlinkSync(filePath, fileLink)
    symlinkSync(directoryPath, directoryLink)
    symlinkSync(join(cwd, 'missing-target'), brokenLink)

    new PiAcpSession({
      sessionId: 's1',
      cwd,
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    proc.emit({ type: 'tool_execution_start', toolCallId: 'file', toolName: 'read', args: { path: fileLink } })
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'directory',
      toolName: 'read',
      args: { path: directoryLink }
    })
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'broken',
      toolName: 'read',
      args: { path: brokenLink }
    })

    await new Promise(r => setTimeout(r, 0))

    assert.equal(conn.updates.length, 3)
    assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: fileLink }])
    assert.equal((conn.updates[1]!.update as any).locations, undefined)
    assert.equal((conn.updates[2]!.update as any).locations, undefined)
  }
)

test('PiAcpSession: handles extension select via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'pi-ui-ui-1',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: handles extension confirm via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'no' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: sends cancelled response when ACP confirm is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-5', method: 'confirm', title: 'Continue?' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', cancelled: true }])
})

test('PiAcpSession: cancels input and editor silently when elicitation was not negotiated', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Enter name' })
  proc.emit({ type: 'extension_ui_request', id: 'ui-4', method: 'editor', title: 'Edit text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-3', cancelled: true },
    { id: 'ui-4', cancelled: true }
  ])
  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits missing write locations at stream boundaries but not deltas', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-streamed-location-'))
  const filePath = join(cwd, 'new.txt')
  const toolCall = {
    id: 't1',
    name: 'write',
    arguments: { path: filePath, content: 'hello' }
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_delta', toolCall }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_end', toolCall }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[1]!.update as any).rawInput, toolCall.arguments)
  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.deepEqual((conn.updates[2]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from edits array when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'needle', newText: 'replacement' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from stringified edits array', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-string-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: JSON.stringify([{ oldText: 'needle', newText: 'replacement' }]) }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt resolves end_turn only at agent_settled, not agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  let resolved = false
  void p.then(() => {
    resolved = true
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  // `agent_end` is only a low-level run boundary; pi may continue with
  // retries/compaction/queued continuations. The ACP prompt must stay open.
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_settled' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: emits startup info once, in-turn, on the first prompt only', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'
  session.setStartupInfo(notice)

  // No prompt is active yet: nothing may be emitted out-of-turn.
  await new Promise(r => setTimeout(r, 0))
  assert.equal(conn.updates.length, 0)

  const startupUpdates = () =>
    conn.updates.filter(
      entry =>
        entry.update.sessionUpdate === 'agent_message_chunk' &&
        (entry.update as any).content?.type === 'text' &&
        (entry.update as any).content?.text === notice
    )

  const first = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  assert.equal(startupUpdates().length, 1)

  // The banner must be the first turn-bound chunk of the first turn.
  const firstChunk = conn.updates.find(entry => entry.update.sessionUpdate === 'agent_message_chunk')
  assert.equal((firstChunk!.update as any).content.text, notice)

  const second = session.prompt('again')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')

  assert.equal(startupUpdates().length, 1)
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it only after agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  // The queued prompt must NOT start at the low-level agent_end boundary.
  await new Promise(r => setTimeout(r, 0))
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: forwards non-adapter slash commands to pi unchanged', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, '/hello world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})
