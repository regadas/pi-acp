import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { replaySessionHistory } from '../../src/acp/history-replay.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('PR 1C: extension approval titles prefer sanitized title, then compact message, then neutral fallback without option/prefill leakage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const eventsOrder: string[] = []
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    eventsOrder.push(`update:${notification.update.sessionUpdate}`)
    await origUpdate(notification)
  }
  const origPerm = conn.requestPermission.bind(conn)
  conn.requestPermission = async (params: RequestPermissionRequest) => {
    eventsOrder.push(`perm:${params.toolCall.title}`)
    return origPerm(params)
  }

  const session = new PiAcpSession({
    sessionId: 's-approval',
    cwd: '/tmp',
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  // 1) Sanitized non-blank title wins.
  proc.emit({
    type: 'extension_ui_request',
    id: 'u1',
    method: 'confirm',
    title: '  Deploy\n\tto production?  ',
    message: 'Secondary detail',
    prefill: 'SECRET_PREFILL'
  })
  // 2) Blank title falls back to compact message, never option/prefill payloads.
  proc.emit({
    type: 'extension_ui_request',
    id: 'u2',
    method: 'select',
    title: '   \n\t  ',
    message: 'Choose target environment',
    options: ['prod-secret-option', 'staging'],
    prefill: 'PREFILL_TEXT'
  })
  // 3) Both title and message absent/blank -> neutral fallback.
  proc.emit({ type: 'extension_ui_request', id: 'u3', method: 'confirm', title: '', message: '   ' })
  proc.emit({
    type: 'extension_ui_request',
    id: 'u4',
    method: 'select',
    options: ['option-payload-must-not-appear']
  })
  await tick()

  assert.deepEqual(
    conn.permissionRequests.map(req => (req as RequestPermissionRequest).toolCall.title),
    ['Deploy to production?', 'Choose target environment', 'Pi confirmation', 'Pi choice']
  )
  // Card flushed before permission request.
  assert.ok(eventsOrder.indexOf('update:tool_call') < eventsOrder.indexOf('perm:Deploy to production?'))
  session.dispose()
})

test('PR 1C: tool_call_update emits changed fields only, clears obsolete locations only when previously set, and retains diff preview on final diff failure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-1c-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'doc.txt')
  writeFileSync(filePath, 'before\r\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's-tool',
    cwd: dir,
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  // 1) Streamed tool call with valid location -> execution changes path to invalid -> clears locations with `[]`!
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: { id: 't-loc', name: 'read', arguments: { path: 'doc.txt' } }
    }
  })
  // Execution starts with identical args except an invalid NUL path: status changes pending->in_progress,
  // locations clears to [] because it was previously set, and no error is thrown!
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-loc',
    toolName: 'read',
    args: { path: 'bad\x00path.txt' }
  })
  // Second tool_execution_update with identical partialResult omits unchanged status and rawOutput if unchanged.
  const partial = { content: [{ type: 'text', text: 'chunk' }] }
  proc.emit({ type: 'tool_execution_update', toolCallId: 't-loc', partialResult: partial })
  proc.emit({ type: 'tool_execution_end', toolCallId: 't-loc', isError: false, result: partial })
  // Duplicate terminal end is completely ignored.
  proc.emit({ type: 'tool_execution_end', toolCallId: 't-loc', isError: false, result: partial })
  await tick()

  const locUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-loc')
  assert.equal(locUpdates[0]?.sessionUpdate, 'tool_call')
  assert.deepEqual((locUpdates[0] as any).locations, [{ path: filePath }])
  assert.equal(locUpdates[1]?.sessionUpdate, 'tool_call_update')
  assert.equal((locUpdates[1] as any).status, 'in_progress')
  assert.deepEqual((locUpdates[1] as any).locations, [], 'obsolete locations cleared when previously set')
  assert.equal((locUpdates[1] as any).kind, undefined, 'unchanged kind omitted')
  assert.equal((locUpdates[1] as any).title, undefined, 'unchanged title omitted')
  assert.equal((locUpdates[1] as any).name, undefined, 'unchanged name omitted')
  assert.equal(locUpdates[2]?.sessionUpdate, 'tool_call_update')
  assert.equal((locUpdates[2] as any).status, undefined, 'unchanged status omitted on progress update')
  assert.equal(locUpdates.filter((u: any) => u.status === 'completed').length, 1, 'terminal transition emitted once')

  // 2) Tool without prior locations never emits `locations: []`.
  conn.updates.length = 0
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 't-noloc', name: 'read' } }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't-noloc', toolName: 'read', args: { path: 'missing.txt' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 't-noloc', isError: false, result: { content: [] } })
  await tick()
  assert.equal(
    conn.updates.some(u => Object.hasOwn(u.update, 'locations')),
    false,
    'never emit locations: [] when no location was previously set'
  )

  // 3) Retain prior diff preview if final diff generation fails (file removed before end).
  conn.updates.length = 0
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-diff',
    toolName: 'edit',
    args: { path: 'doc.txt', edits: [{ oldText: 'before', newText: 'after' }] }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't-diff',
    partialResult: { details: { diff: '--- doc.txt\r\n+++ doc.txt\r\n-before\r\n+after\r\n' } }
  })
  // Remove file so post-edit snapshot fails (returns null, not string).
  unlinkSync(filePath)
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-diff',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })
  await tick()

  const diffUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-diff')
  const preview = diffUpdates[1] as any
  assert.equal(preview.sessionUpdate, 'tool_call_update')
  assert.equal(preview.content?.[0]?.content?.text, '--- doc.txt\r\n+++ doc.txt\r\n-before\r\n+after\r\n')
  const final = diffUpdates[2] as any
  assert.equal(final.status, 'completed')
  assert.equal(final.content, undefined, 'omits terse replacement content so prior diff preview stays intact')

  // 4) Replay deduplicates duplicate assistant toolCall IDs and duplicate terminal toolResult entries.
  conn.updates.length = 0
  proc.entrySnapshot = {
    entries: [
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'dup-1', name: 'read', arguments: {} }] }
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        message: { role: 'toolResult', toolCallId: 'dup-1', toolName: 'read', content: [{ type: 'text', text: 'a' }] }
      },
      {
        type: 'message',
        id: 'e2b',
        parentId: 'e2',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'dup-1', name: 'read', arguments: {} }] }
      },
      {
        type: 'message',
        id: 'e3',
        parentId: 'e2b',
        message: { role: 'toolResult', toolCallId: 'dup-1', toolName: 'read', content: [{ type: 'text', text: 'b' }] }
      }
    ],
    leafId: 'e3'
  }
  await replaySessionHistory({
    session,
    cwd: dir,
    supportsTerminalOutputMeta: false,
    assertActive() {},
    sendUpdate: update => session.sendSessionUpdate(update)
  })
  assert.equal(
    conn.updates.filter(u => u.update.sessionUpdate === 'tool_call' && (u.update as any).toolCallId === 'dup-1').length,
    1,
    'replay emits tool_call at most once per toolCallId (no downgrade after settlement)'
  )
  assert.equal(
    conn.updates.filter(u => u.update.sessionUpdate === 'tool_call_update' && (u.update as any).toolCallId === 'dup-1')
      .length,
    1,
    'replay emits terminal tool_call_update at most once per toolCallId'
  )

  // 5) Late model-stream toolcall_start/delta/end after tool_execution_start cannot clobber execution locations, rawInput, or bash title.
  const execFile = join(dir, 'exec.txt')
  writeFileSync(execFile, 'alpha\nbeta\n', 'utf8')
  conn.updates.length = 0
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-late-stream',
    toolName: 'edit',
    args: { path: 'exec.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 't-late-stream', toolName: 'edit' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 0,
      id: 't-late-stream',
      toolName: 'edit',
      argumentsDelta: '{"path":"bad'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't-late-stream', name: 'edit', arguments: { path: 'bad\x00path' } }
    }
  })

  // Bash tool: late toolcall_start/delta/end after tool_execution_start must never clobber bash title.
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-late-bash',
    toolName: 'bash',
    args: { command: 'npm test' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 't-late-bash', toolName: 'bash' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 1,
      id: 't-late-bash',
      toolName: 'bash',
      argumentsDelta: '{"command":"wrong'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 't-late-bash', name: 'bash', arguments: { command: 'clobbered' } }
    }
  })
  await tick()
  const lateUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-late-stream')
  assert.equal(lateUpdates.length, 1, 'late toolcall_start/delta/end after execution start must emit no updates')
  assert.deepEqual((lateUpdates[0] as any).locations, [{ path: execFile, line: 2 }])
  assert.deepEqual((lateUpdates[0] as any).rawInput, {
    path: 'exec.txt',
    edits: [{ oldText: 'beta', newText: 'gamma' }]
  })

  const lateBashUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-late-bash')
  assert.equal(lateBashUpdates.length, 1, 'late bash toolcall_* after execution start must emit no updates')
  assert.equal((lateBashUpdates[0] as any).title, 'npm test')

  // 6) Tool B reusing executing Tool A's contentIndex must not have its buffer corrupted or deleted by late Tool A events.
  conn.updates.length = 0
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-reuse-a',
    toolName: 'read',
    args: { path: 'exec.txt' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 3, id: 't-reuse-b', toolName: 'read' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 3,
      id: 't-reuse-b',
      argumentsDelta: '{"path":'
    }
  })
  // Late delta and end for executing Tool A at the same contentIndex must NOT corrupt or delete Tool B's buffer.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 3,
      id: 't-reuse-a',
      argumentsDelta: 'CORRUPT'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 3,
      toolCall: { id: 't-reuse-a', name: 'read', arguments: { path: 'wrong.txt' } }
    }
  })
  // Finish Tool B streaming cleanly.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 3,
      id: 't-reuse-b',
      argumentsDelta: '"exec.txt"}'
    }
  })
  // Late ID-less toolcall_start at the same contentIndex must NOT reset Tool B's buffer.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 3,
      toolName: 'bash'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 3,
      id: 't-reuse-b',
      toolName: 'read'
    }
  })
  await tick()
  const toolBUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-reuse-b')
  const toolBWithInput = toolBUpdates.find((u: any) => u.rawInput?.path === 'exec.txt') as any
  assert.ok(toolBWithInput, 'Tool B buffer must survive late Tool A delta/end at the same contentIndex')
  assert.deepEqual(toolBWithInput.rawInput, { path: 'exec.txt' })

  // 7) Progress-only tool_execution_update (without tool_execution_start) followed by late toolcall_delta/end never clobbers title/rawInput/locations.
  conn.updates.length = 0
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't-progress-only',
    toolName: 'read',
    args: { path: 'exec.txt' },
    partialResult: { content: [{ type: 'text', text: 'working' }] }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 4,
      id: 't-progress-only',
      toolName: 'read',
      argumentsDelta: '{"path":"bad'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 4,
      toolCall: { id: 't-progress-only', name: 'read', arguments: { path: 'bad\x00path' } }
    }
  })
  await tick()
  const progUpdates = conn.updates.map(u => u.update).filter((u: any) => u.toolCallId === 't-progress-only')
  assert.equal(progUpdates[0]?.sessionUpdate, 'tool_call')
  assert.deepEqual((progUpdates[0] as any).locations, [{ path: execFile }])
  assert.deepEqual((progUpdates[0] as any).rawInput, { path: 'exec.txt' })
  assert.equal(
    progUpdates
      .slice(1)
      .some((u: any) => Object.hasOwn(u, 'title') || Object.hasOwn(u, 'rawInput') || Object.hasOwn(u, 'locations')),
    false,
    'late toolcall_delta/end after progress-only tool_execution_update must never clobber title, rawInput, or locations'
  )

  session.dispose()
})

test('PR 1C: cancelled turn returns owned-turn usage without querying dead transport, aggregates attempts, and excludes background/prior turns', async () => {
  const conn = new FakeAgentSideConnection()
  let statsCalls = 0
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => {
    statsCalls += 1
    return { tokens: { input: 999, output: 999, total: 1998 } }
  }
  // Abort throws so cancel quarantines/disposes the channel (dead transport!).
  proc.abort = async () => {
    throw new Error('abort failed')
  }

  const session = new PiAcpSession({
    sessionId: 's-cancel-usage',
    cwd: '/tmp',
    proc,
    conn: asAgentConn(conn)
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: () => (session.isUnavailable() ? undefined : session),
    evictIfCurrent: () => true
  }

  // Autonomous/background event usage BEFORE the owned turn must never leak.
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { input: 500, output: 100, totalTokens: 600 } }
  })
  proc.emit({ type: 'agent_settled' })

  const promptPromise = agent.prompt({
    sessionId: 's-cancel-usage',
    prompt: [{ type: 'text', text: 'do work' }]
  })
  await tick()
  proc.emit({ type: 'agent_start' })
  // Attempt 1 completes (e.g. tool call)
  proc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      usage: { input: 20, output: 10, cacheRead: 5, totalTokens: 35 }
    }
  })
  // Attempt 2 streams partial usage (replace within attempt)
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 30, output: 4, totalTokens: 34 } },
    assistantMessageEvent: { type: 'text_delta', delta: 'part 1' }
  })
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 30, output: 12, totalTokens: 42 } },
    assistantMessageEvent: { type: 'text_delta', delta: ' part 2' }
  })

  // Queue a second prompt that will never be dispatched.
  const queuedPromise = agent.prompt({
    sessionId: 's-cancel-usage',
    prompt: [{ type: 'text', text: 'queued work' }]
  })
  await tick()

  await agent.cancel({ sessionId: 's-cancel-usage' })
  const cancelledRes = await promptPromise
  const queuedRes = await queuedPromise

  assert.equal(cancelledRes.stopReason, 'cancelled')
  assert.deepEqual(cancelledRes.usage, {
    inputTokens: 50,
    outputTokens: 22,
    totalTokens: 77,
    cachedReadTokens: 5
  })
  assert.equal(statsCalls, 0, 'must never query getSessionStats on a dead/quarantined transport')
  assert.equal(queuedRes.stopReason, 'cancelled')
  assert.equal(queuedRes.usage, undefined, 'never-dispatched queued cancel must not inherit active usage')
})

test('PR 1C: cancelling on a healthy child with prior-turn cumulative stats neither calls getSessionStats nor borrows prior-turn totals, and next turn succeeds', async t => {
  const conn = new FakeAgentSideConnection()
  let statsCalls = 0
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => {
    statsCalls += 1
    return {
      tokens: { input: 500, output: 200, total: 700 },
      contextUsage: { tokens: 120, contextWindow: 1000 }
    }
  }
  const session = new PiAcpSession({
    sessionId: 's-healthy-cancel',
    cwd: '/tmp',
    proc,
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: () => session,
    evictIfCurrent: () => true
  }

  // Turn 1 completes normally and populates cumulative session stats.
  const turn1 = agent.prompt({ sessionId: 's-healthy-cancel', prompt: [{ type: 'text', text: 'first' }] })
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  const res1 = await turn1
  assert.equal(res1.stopReason, 'end_turn')
  assert.equal(res1.usage?.totalTokens, 700)
  assert.equal(statsCalls, 1)

  // Turn 2 is cancelled before producing any owned usage sample: must NOT call getSessionStats
  // and must NOT borrow Turn 1's 700 cumulative tokens.
  const turn2 = agent.prompt({ sessionId: 's-healthy-cancel', prompt: [{ type: 'text', text: 'second' }] })
  await tick()
  proc.emit({ type: 'agent_start' })
  const cancelling = agent.cancel({ sessionId: 's-healthy-cancel' })
  await tick()
  proc.emit({ type: 'agent_settled' })
  await cancelling
  const res2 = await turn2
  assert.equal(res2.stopReason, 'cancelled')
  assert.equal(res2.usage, undefined, 'cancelled turn without owned usage must not borrow prior-turn totals')
  assert.equal(statsCalls, 1, 'healthy cancellation must not invoke getSessionStats')
  assert.equal(session.isUnavailable(), false)

  // Turn 3 on the same healthy child completes cleanly.
  const turn3 = agent.prompt({ sessionId: 's-healthy-cancel', prompt: [{ type: 'text', text: 'third' }] })
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  const res3 = await turn3
  assert.equal(res3.stopReason, 'end_turn')
  assert.equal(statsCalls, 2)
})
