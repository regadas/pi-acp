import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'

import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-bash-coalesce-cwd-'))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const fenced = (text: string) => [
  {
    type: 'content',
    content: { type: 'text', text: '```console\n' + text + (text.endsWith('\n') ? '' : '\n') + '```' }
  }
]

type ToolCallUpdateMessage = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess, coalesceBytes?: number) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    supportsTerminalOutputMeta: false,
    ...(coalesceBytes === undefined ? {} : { genericBashCoalesceBytes: coalesceBytes })
  })
}

const startBash = (proc: FakePiRpcProcess, toolCallId: string) =>
  proc.emit({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'seq' } })

const emitSnapshot = (proc: FakePiRpcProcess, toolCallId: string, partialResult: unknown) =>
  proc.emit({ type: 'tool_execution_update', toolCallId, partialResult })

const endBash = (proc: FakePiRpcProcess, toolCallId: string, result: unknown, isError = false) =>
  proc.emit({ type: 'tool_execution_end', toolCallId, isError, result })

function updatesFor(conn: FakeAgentSideConnection, toolCallId: string): ToolCallUpdateMessage[] {
  return conn.updates
    .map(u => u.update)
    .filter((update): update is ToolCallUpdateMessage => update.sessionUpdate === 'tool_call_update')
    .filter(update => update.toolCallId === toolCallId)
}

const coalescingState = (session: PiAcpSession) =>
  session as unknown as {
    genericBashEmittedMeasure: Map<string, { native: boolean; bytes: number }>
    genericBashSnapshots: Map<string, unknown>
  }

test('PiAcpSession: generic bash updates below the growth threshold coalesce', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  // Growth steps chosen so the last step MUST flush against the first emit:
  // +30/+30/+30 individually stay under the 64-byte threshold, while the
  // +90 total growth since the last emit crosses it — a baseline that
  // drifted with every suppressed snapshot would never flush.
  const steps = [40, 70, 100, 130].map(size => 'a'.repeat(size))

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  for (const text of steps) emitSnapshot(proc, 'b1', { content: [{ type: 'text', text }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'final output' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(steps[0]!)],
      ['in_progress', fenced(steps[3]!)],
      ['completed', fenced('final output')]
    ],
    'only the first snapshot, the threshold flush, and the terminal update reach generic clients'
  )
  const state = coalescingState(session)
  assert.equal(state.genericBashEmittedMeasure.size, 0, 'per-tool-call thresholds are cleaned up with the tool call')
  assert.equal(state.genericBashSnapshots.size, 0, 'retained snapshots are cleaned up with the tool call')
})

test('PiAcpSession: generic bash updates flush mid-stream once growth passes the threshold', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const first = 'x'.repeat(50)
  const second = first + 'y'.repeat(100)
  const suppressed = second + 'z'.repeat(10)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: second }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: suppressed }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['in_progress', fenced(second)],
      ['completed', fenced('done')]
    ],
    'each flush carries the whole current snapshot, never a delta'
  )
})

test('PiAcpSession: a failed terminal generic bash update always carries its full content', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const first = 'x'.repeat(50)
  const suppressed = first + 'y'.repeat(10)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: suppressed }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'boom' }], details: { exitCode: 1 } }, true)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const updates = updatesFor(conn, 'b1')
  assert.deepEqual(
    updates.map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['failed', fenced('boom')]
    ],
    'a suppressed in_progress snapshot never suppresses the terminal failure'
  )
})

test('PiAcpSession: an empty generic in_progress bash update emits nothing', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', {})
  await tick()
  assert.equal(updatesFor(conn, 'b1').length, 0, 'an empty snapshot produces no tool_call_update')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: 'first' }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced('first')],
      ['completed', fenced('done')]
    ]
  )
})

test('PiAcpSession: coalescing thresholds are tracked per bash tool call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const b1First = 'one'.repeat(20)
  const b2First = 'two'.repeat(20)
  const b1Grown = b1First + 'x'.repeat(10)
  const b1Flush = b1First + 'x'.repeat(80)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  startBash(proc, 'b2')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: b1First }] })
  emitSnapshot(proc, 'b2', { content: [{ type: 'text', text: b2First }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: b1Grown }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: b1Flush }] })
  endBash(proc, 'b2', { content: [{ type: 'text', text: 'done two' }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done one' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(b1First)],
      ['in_progress', fenced(b1Flush)],
      ['completed', fenced('done one')]
    ],
    'b1 coalesces against its own last emit regardless of b2 traffic'
  )
  assert.deepEqual(
    updatesFor(conn, 'b2').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(b2First)],
      ['completed', fenced('done two')]
    ]
  )
})

const truncatedSnapshot = (
  window: string,
  coords: { totalLines: number; totalBytes: number; outputLines: number }
) => ({
  content: [{ type: 'text', text: window }],
  details: { truncation: { truncated: true, truncatedBy: 'lines', ...coords, content: window } }
})

test('PiAcpSession: a coalesced native-measure snapshot never moves the emitted measure', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: 'x'.repeat(10) }] })
  emitSnapshot(proc, 'b1', truncatedSnapshot('y'.repeat(100), { totalLines: 3, totalBytes: 200, outputLines: 3 }))
  emitSnapshot(proc, 'b1', truncatedSnapshot('y'.repeat(100), { totalLines: 3, totalBytes: 230, outputLines: 3 }))
  emitSnapshot(proc, 'b1', truncatedSnapshot('z'.repeat(100), { totalLines: 4, totalBytes: 400, outputLines: 3 }))
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced('x'.repeat(10))],
      ['in_progress', fenced('y'.repeat(100))],
      ['in_progress', fenced('z'.repeat(100))],
      ['completed', fenced('done')]
    ],
    'the rendered measure, the kind change, and the native flush emit; the sub-threshold native snapshot coalesces'
  )
  const state = coalescingState(session)
  assert.equal(state.genericBashEmittedMeasure.size, 0, 'the measure is cleaned up with the tool call')
})

test('PiAcpSession: sub-threshold fallback updates measure escape-aware raw text before rendering', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  // Backslashes double once JSON-escaped, so a raw byte count would halve the
  // growth basis: the escape-aware count proves the measure was taken on the
  // result text, before any rendering, without undercounting escapes.
  const first = '\\'.repeat(40)
  const suppressed = first + '\\'.repeat(10)
  const flush = first + '\\'.repeat(80)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  const afterFirst = coalescingState(session).genericBashEmittedMeasure.get('b1')
  assert.deepEqual(
    afterFirst,
    { native: false, bytes: 80 },
    'the fallback measure is the escape-aware raw text size, not a rendered one'
  )

  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: suppressed }] })
  assert.deepEqual(
    coalescingState(session).genericBashEmittedMeasure.get('b1'),
    afterFirst,
    'a sub-threshold update neither emits nor moves the measure'
  )

  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: flush }] })
  assert.deepEqual(
    coalescingState(session).genericBashEmittedMeasure.get('b1'),
    { native: false, bytes: 240 },
    'a threshold flush re-baselines on the escape-aware raw text size'
  )

  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['in_progress', fenced(flush)],
      ['completed', fenced('done')]
    ],
    'only the first snapshot, the raw-growth flush, and the terminal update reach generic clients'
  )
})

test('PiAcpSession: escape-heavy growth emits at the threshold the rendered basis emitted', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  // Backslashes double once JSON-escaped: 32 more raw bytes are 64 escaped
  // bytes, exactly the threshold the rendered-byte basis emitted on. A raw
  // byte count (32) would suppress the update the old basis emitted.
  const first = '\\'.repeat(40)
  const second = '\\'.repeat(72)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: second }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['in_progress', fenced(second)],
      ['completed', fenced('done')]
    ],
    'escape-heavy growth flushes on the escaped byte count, matching the old rendered-basis emission'
  )
})

test('PiAcpSession: escape-heavy growth flushes at the production threshold arithmetic', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // No seam override: the production 64 KiB threshold applies. Escaping
  // doubles backslashes, so half a threshold of added backslashes — 32,768
  // raw bytes, 65,536 escaped bytes — crosses the threshold exactly as the
  // rendered-byte basis did; a raw byte count (32,768) would suppress it.
  const session = makeSession(conn, proc)
  const first = '\\'.repeat(32_768)
  const second = first + '\\'.repeat(32_768)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: second }] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['in_progress', fenced(second)],
      ['completed', fenced('done')]
    ],
    '32,768 added backslashes are 65,536 escaped bytes: the production threshold flushes'
  )
})

test('PiAcpSession: capped windows flush on native totalBytes growth at the production threshold', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // No seam override: the production 64 KiB threshold applies, which rendered
  // bytes alone can never cross once pi caps the window.
  const session = makeSession(conn, proc)
  const window = 'y'.repeat(51200)
  const capped = (totalBytes: number) => truncatedSnapshot(window, { totalLines: 1400, totalBytes, outputLines: 1280 })

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: 'x'.repeat(1000) }] })
  emitSnapshot(proc, 'b1', capped(68536))
  emitSnapshot(proc, 'b1', capped(69536))
  // Native-to-native growth past the threshold must flush on its own bytes:
  // the earlier flush rode the measure-kind change, which would mask a broken
  // native measure (e.g. always reading 0 or totalLines).
  emitSnapshot(
    proc,
    'b1',
    truncatedSnapshot('z'.repeat(51200), { totalLines: 1500, totalBytes: 138536, outputLines: 1280 })
  )
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'final done\n' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced('x'.repeat(1000))],
      ['in_progress', fenced(window)],
      ['in_progress', fenced('z'.repeat(51200))],
      ['completed', fenced('final done\n')]
    ],
    'totalBytes growth flushes the capped window; sub-threshold totalBytes growth stays coalesced'
  )
})

test('PiAcpSession: a capped window flushes even when escaping inflated the rendered baseline', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  // 50,000 backslashes render as >100,000 JSON bytes, while the first capped
  // snapshot's native totalBytes is only 115,536: a mixed-unit comparison
  // (115,536 - 100,000+) suppresses a full threshold of new output.
  const escaped = '\\'.repeat(50000)
  const window = '\\'.repeat(51200)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: escaped }] })
  emitSnapshot(proc, 'b1', truncatedSnapshot(window, { totalLines: 1300, totalBytes: 115536, outputLines: 1280 }))
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done\n' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(escaped)],
      ['in_progress', fenced(window)],
      ['completed', fenced('done\n')]
    ],
    'crossing from a rendered measure to native totalBytes always flushes, whatever escaping did to the baseline'
  )
})

test('PiAcpSession: a synthetic terminal failure carries the latest suppressed bash output', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const first = 'first'
  const latest = 'first\nimportant error'

  const outcome = assert.rejects(session.prompt('run it'), /pi process exited unexpectedly/)
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: first }] })
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: latest }] })
  // An empty update must not erase the suppressed snapshot: the synthetic
  // failure still renders the last content-bearing output, not nothing.
  emitSnapshot(proc, 'b1', {})
  proc.emitTermination({ expected: false })
  await outcome
  await tick()

  const failed = updatesFor(conn, 'b1').at(-1)
  assert.equal(failed?.status, 'failed')
  assert.deepEqual(
    failed?.content,
    fenced(latest),
    'the client keeps the latest known output, not the last emitted one and not an erased one'
  )
})

test('PiAcpSession: an image-only generic in_progress bash update emits immediately', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const image = { type: 'image', data: 'aGk=', mimeType: 'image/png' }

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [image] })
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'done' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', [{ type: 'content', content: image }]],
      ['completed', fenced('done')]
    ],
    'an image-bearing update has no measurable text basis, so it bypasses text-growth coalescing'
  )
})

test('PiAcpSession: a synthetic terminal failure renders a retained image-only snapshot', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, 64)
  const image = { type: 'image', data: 'aGk=', mimeType: 'image/png' }

  const outcome = assert.rejects(session.prompt('run it'), /pi process exited unexpectedly/)
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [image] })
  proc.emitTermination({ expected: false })
  await outcome
  await tick()

  const failed = updatesFor(conn, 'b1').at(-1)
  assert.equal(failed?.status, 'failed')
  assert.deepEqual(
    failed?.content,
    [{ type: 'content', content: image }],
    'an image-only snapshot is retained for the synthetic failure even with no text'
  )
})
