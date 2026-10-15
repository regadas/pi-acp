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

test('PiAcpSession: negotiated streaming appends only new output when the tail window rolls', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, true)
  // Real pi 1.1.0 OutputAccumulator: below the 2000-line cap the snapshot
  // keeps the trailing newline; once the window rolls, the kept lines are
  // joined without one, and the final result appends the truncation note.
  const windowText = (from: number, to: number, trailingNewline = false) =>
    Array.from({ length: to - from + 1 }, (_, i) => `line${from + i}`).join('\n') + (trailingNewline ? '\n' : '')
  const first = windowText(1, 2000, true)
  const rolled = windowText(2, 2001)
  const annotation = '\n\n[Showing lines 2-2001 of 2001. Full output: /tmp/pi-bash-x8.log]'

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq 2001' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'b1',
    partialResult: { content: [{ type: 'text', text: first }] }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'b1',
    partialResult: { content: [{ type: 'text', text: rolled }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    isError: false,
    result: { content: [{ type: 'text', text: rolled + annotation }], details: { exitCode: 0 } }
  })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const deltas = conn.updates
    .map(u => (u as any).update)
    .filter(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1')
    .map(u => u._meta?.terminal_output?.data)
  assert.deepEqual(deltas, [first, 'line2001', annotation], 'each update must append only new output')
})

// Native pi 1.1.0 streaming records: `details.truncation` carries the
// cumulative totals (totalLines/totalBytes) plus the window coordinates
// (outputLines, content) of the rolling tail snapshot.
function truncatedRecord(
  window: string,
  coords: { totalLines: number; totalBytes: number; outputLines: number },
  annotation = '',
  lastLinePartial = false
) {
  return {
    content: [{ type: 'text', text: window + annotation }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: lastLinePartial ? 'bytes' : 'lines',
        ...coords,
        content: window,
        lastLinePartial
      }
    }
  }
}

const linesText = (from: number, to: number, trailingNewline = false) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line${from + i}`).join('\n') + (trailingNewline ? '\n' : '')

const linesStreamBytes = (totalLines: number) =>
  Buffer.byteLength(Array.from({ length: totalLines }, (_, i) => `line${i + 1}\n`).join(''))

async function terminalDeltas(updates: unknown[], finalResult: unknown): Promise<Array<string | undefined>> {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, true)
  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq' } })
  for (const partialResult of updates) proc.emit({ type: 'tool_execution_update', toolCallId: 'b1', partialResult })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'b1', isError: false, result: finalResult })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()
  return conn.updates
    .map(u => (u as any).update)
    .filter(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'b1')
    .map(u => u._meta?.terminal_output?.data)
}

test('PiAcpSession: terminal deltas follow an open line growing, closing, and the next line', async () => {
  // Real pi 1.1.0 OutputAccumulator trace for 'v\n' x2000 + 'open', then
  // 'xyz', then the terminator, then 'next\n'. Snapshot values (windows,
  // cumulative totals, window line counts) cross-checked against the
  // installed accumulator; not imported here because CI validates before
  // pi is installed.
  const w1 = 'v\n'.repeat(1999) + 'open'
  const w2 = 'v\n'.repeat(1999) + 'openxyz'
  const w4 = 'v\n'.repeat(1998) + 'openxyz\nnext'
  const annotation = '\n\n[Showing lines 3-2002 of 2002. Full output: /tmp/pi-bash-r3.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(w1, { totalLines: 2001, totalBytes: 4004, outputLines: 2000 }),
      truncatedRecord(w2, { totalLines: 2001, totalBytes: 4007, outputLines: 2000 }),
      truncatedRecord(w2, { totalLines: 2001, totalBytes: 4008, outputLines: 2000 }),
      truncatedRecord(w4, { totalLines: 2002, totalBytes: 4013, outputLines: 2000 })
    ],
    truncatedRecord(w4, { totalLines: 2002, totalBytes: 4013, outputLines: 2000 }, annotation)
  )
  assert.deepEqual(
    deltas,
    [w1, 'xyz', '\n', 'next', annotation],
    'growth, the terminator, then the next line without a double separator, and the final annotation'
  )
})

test('PiAcpSession: identical rolling windows with progress still append the new repeated lines', async () => {
  // Audit reproduction: `repeat\n` x2011 then 10 more lines. Both rolling
  // windows are byte-identical, so text comparison alone yields an empty
  // delta and the 10 new lines would never reach the terminal.
  const window = 'repeat\n'.repeat(1999) + 'repeat'
  const tenMore = 'repeat\n'.repeat(9) + 'repeat'
  // Coherent totals: 2000 complete lines + the open line = 14006 bytes;
  // ten more lines bring 70 bytes (nine terminators included) to 14076.
  const before = { totalLines: 2001, totalBytes: 14006, outputLines: 2000 }
  const after = { totalLines: 2011, totalBytes: 14076, outputLines: 2000 }
  const annotation = '\n\n[Showing lines 12-2011 of 2011. Full output: /tmp/pi-bash-r1.log]'

  const progressed = await terminalDeltas(
    [truncatedRecord(window, before), truncatedRecord(window, after)],
    truncatedRecord(window, after, annotation)
  )
  assert.deepEqual(
    progressed,
    [window, '\n' + tenMore, annotation],
    'identical windows with progressed totals must still append the new lines, then the final annotation'
  )

  const retransmitted = await terminalDeltas(
    [truncatedRecord(window, before), truncatedRecord(window, before)],
    truncatedRecord(window, before, annotation)
  )
  assert.deepEqual(
    retransmitted,
    [window, undefined, annotation],
    'a retransmitted window without progress appends nothing; the final annotation still lands once'
  )
})

test('PiAcpSession: disjoint rolling windows keep their line boundary', async () => {
  // A burst of 2000 lines between throttled updates moves the window fully
  // past everything previously shown; the append must not glue line2001 and
  // line2002 together.
  const firstWindow = linesText(2, 2001)
  const secondWindow = linesText(2002, 4001)
  const annotation = '\n\n[Showing lines 2002-4001 of 4001. Full output: /tmp/pi-bash-r2.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(firstWindow, { totalLines: 2001, totalBytes: linesStreamBytes(2001), outputLines: 2000 }),
      truncatedRecord(secondWindow, { totalLines: 4001, totalBytes: linesStreamBytes(4001), outputLines: 2000 })
    ],
    truncatedRecord(
      secondWindow,
      { totalLines: 4001, totalBytes: linesStreamBytes(4001), outputLines: 2000 },
      annotation
    )
  )
  assert.deepEqual(
    deltas,
    [firstWindow, '\n' + secondWindow, annotation],
    'a disjoint window is appended whole behind a line separator, then the final annotation'
  )
})

test('PiAcpSession: a blank tail line survives zero-text progress and the next line separator', async () => {
  // Native trace for 'v\n' x2000 + 'open', then '\n', then another '\n',
  // then 'next\n': the blank line's snapshot emits no visible text, so its
  // terminator must survive in the logical tail state and land before the
  // next line instead of gluing 'next' onto 'open'.
  const w1 = 'v\n'.repeat(1999) + 'open'
  const w3 = 'v\n'.repeat(1998) + 'open\n'
  const w4 = 'v\n'.repeat(1997) + 'open\n\nnext'
  const annotation = '\n\n[Showing lines 4-2003 of 2003. Full output: /tmp/pi-bash-r4.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(w1, { totalLines: 2001, totalBytes: 4004, outputLines: 2000 }),
      truncatedRecord(w1, { totalLines: 2001, totalBytes: 4005, outputLines: 2000 }),
      truncatedRecord(w3, { totalLines: 2002, totalBytes: 4006, outputLines: 2000 }),
      truncatedRecord(w4, { totalLines: 2003, totalBytes: 4011, outputLines: 2000 })
    ],
    truncatedRecord(w4, { totalLines: 2003, totalBytes: 4011, outputLines: 2000 }, annotation)
  )
  assert.deepEqual(
    deltas,
    [w1, '\n', undefined, '\nnext', annotation],
    'the open line, its terminator, the blank line via state, then the next line behind its separator'
  )
})

test('PiAcpSession: a blank line between terminated lines keeps its separator', async () => {
  // Native trace for 'x\n' x2001, then 'a\n\n', then 'b\n': the blank line
  // appears as the window's trailing separator; the last delta must open
  // with that separator so 'a' and 'b' stay blank-separated.
  const w1 = 'x\n'.repeat(1999) + 'x'
  const w2 = 'x\n'.repeat(1998) + 'a\n'
  const w3 = 'x\n'.repeat(1997) + 'a\n\nb'
  const annotation = '\n\n[Showing lines 5-2004 of 2004. Full output: /tmp/pi-bash-r5.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(w1, { totalLines: 2001, totalBytes: 4002, outputLines: 2000 }),
      truncatedRecord(w2, { totalLines: 2003, totalBytes: 4005, outputLines: 2000 }),
      truncatedRecord(w3, { totalLines: 2004, totalBytes: 4007, outputLines: 2000 })
    ],
    truncatedRecord(w3, { totalLines: 2004, totalBytes: 4007, outputLines: 2000 }, annotation)
  )
  assert.deepEqual(
    deltas,
    [w1, '\na\n', '\nb', annotation],
    'the blank line arrives as the separator before b, not glued after a'
  )
})

test('PiAcpSession: a first window ending in a newline is a blank tail line, not a terminator', async () => {
  // Native trace for 'x\n' x2001 plus a final blank line, then 'y': the
  // first observed window ends with the separator before that blank line —
  // that trailing newline is not the blank line's emitted terminator, so
  // 'y' must arrive behind another separator instead of overwriting it.
  const w1 = 'x\n'.repeat(1999)
  const w2 = 'x\n'.repeat(1998) + '\ny'
  const annotation = '\n\n[Showing lines 4-2003 of 2003. Full output: /tmp/pi-bash-r6.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(w1, { totalLines: 2002, totalBytes: 4003, outputLines: 2000 }),
      truncatedRecord(w2, { totalLines: 2003, totalBytes: 4004, outputLines: 2000 })
    ],
    truncatedRecord(w2, { totalLines: 2003, totalBytes: 4004, outputLines: 2000 }, annotation)
  )
  assert.deepEqual(deltas, [w1, '\ny', annotation], 'the blank tail line keeps its separator ahead of the next line')
})

test('PiAcpSession: terminal deltas keep a verbatim tail terminator after a trimmed giant line', async () => {
  // Native pi 1.1.0 trace (50KiB/2000-line caps): 'x'x300000, '\n', 'v\n',
  // then 'w\n'x2000. The giant line is byte-truncated to 51200 bytes and
  // trimmed from the tail, so the globally-truncated snapshot keeps the
  // short tail 'v\n' VERBATIM — real trailing terminator included. The
  // final burst joins 2000 w-lines without one; its window must follow the
  // emitted 'v\n' directly instead of opening with a spurious blank
  // separator, and the trimmed-away empty snapshot emits no text.
  const giantTail = 'x'.repeat(51200)
  const wWindow = 'w\n'.repeat(1999) + 'w'
  const annotation = '\n\n[Showing lines 3-2002 of 2002. Full output: /tmp/pi-bash-r7.log]'
  const deltas = await terminalDeltas(
    [
      truncatedRecord(giantTail, { totalLines: 1, totalBytes: 300000, outputLines: 1 }, '', true),
      truncatedRecord('', { totalLines: 1, totalBytes: 300001, outputLines: 0 }),
      truncatedRecord('v\n', { totalLines: 2, totalBytes: 300003, outputLines: 1 }),
      truncatedRecord(wWindow, { totalLines: 2002, totalBytes: 304003, outputLines: 2000 })
    ],
    truncatedRecord(wWindow, { totalLines: 2002, totalBytes: 304003, outputLines: 2000 }, annotation)
  )
  assert.deepEqual(
    deltas,
    [giantTail, undefined, 'v\n', wWindow, annotation],
    'the empty snapshot emits nothing, the verbatim terminator is real, and the joined window follows it directly'
  )
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
