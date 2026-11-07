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
    genericBashEmittedBytes: { size: number }
    genericBashContent: { size: number }
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
  assert.equal(state.genericBashEmittedBytes.size, 0, 'per-tool-call thresholds are cleaned up with the tool call')
  assert.equal(state.genericBashContent.size, 0, 'retained content is cleaned up with the tool call')
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

test('PiAcpSession: capped windows flush on native totalBytes growth at the production threshold', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // No seam override: the production 64 KiB threshold applies, which rendered
  // bytes alone can never cross once pi caps the window.
  const session = makeSession(conn, proc)
  const window = 'y'.repeat(51200)
  const capped = (totalBytes: number) => ({
    content: [{ type: 'text', text: window }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: 'lines',
        totalLines: 1400,
        totalBytes,
        outputLines: 1280,
        content: window
      }
    }
  })

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  startBash(proc, 'b1')
  emitSnapshot(proc, 'b1', { content: [{ type: 'text', text: 'x'.repeat(1000) }] })
  emitSnapshot(proc, 'b1', capped(68536))
  emitSnapshot(proc, 'b1', capped(69536))
  endBash(proc, 'b1', { content: [{ type: 'text', text: 'final done\n' }] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  assert.deepEqual(
    updatesFor(conn, 'b1').map(update => [update.status, update.content]),
    [
      ['in_progress', fenced('x'.repeat(1000))],
      ['in_progress', fenced(window)],
      ['completed', fenced('final done\n')]
    ],
    'totalBytes growth flushes the capped window; sub-threshold totalBytes growth stays coalesced'
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
  proc.emitTermination({ expected: false })
  await outcome
  await tick()

  const failed = updatesFor(conn, 'b1').at(-1)
  assert.equal(failed?.status, 'failed')
  assert.deepEqual(
    failed?.content,
    fenced(latest),
    'the client keeps the latest known output, not the last emitted one'
  )
})
