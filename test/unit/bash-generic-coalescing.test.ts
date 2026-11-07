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

const fenced = (text: string) => [{ type: 'content', content: { type: 'text', text: '```console\n' + text + '\n```' } }]

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    supportsTerminalOutputMeta: false,
    genericBashCoalesceBytes: 64
  })
}

type ToolCallUpdateMessage = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>

async function runBashTurn(snapshots: string[], finalResult: unknown) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const prompt = session.prompt('run it')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'seq' } })
  for (const partialResult of snapshots)
    proc.emit({
      type: 'tool_execution_update',
      toolCallId: 'b1',
      partialResult: { content: [{ type: 'text', text: partialResult }] }
    })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'b1', isError: false, result: finalResult })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  await tick()

  const updates = conn.updates
    .map(u => u.update)
    .filter((update): update is ToolCallUpdateMessage => update.sessionUpdate === 'tool_call_update')
    .filter(update => update.toolCallId === 'b1')
  return { conn, session, updates }
}

test('PiAcpSession: generic bash updates below the growth threshold coalesce', async () => {
  const first = 'a'.repeat(40)
  const { session, updates } = await runBashTurn(
    [first, first + 'b'.repeat(30), first + 'b'.repeat(30) + 'c'.repeat(10)],
    { content: [{ type: 'text', text: 'final output' }] }
  )

  assert.deepEqual(
    updates.map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['completed', fenced('final output')]
    ],
    'only the first non-empty snapshot and the terminal update reach generic clients'
  )
  assert.equal(
    (session as unknown as { genericBashEmittedBytes: { size: number } }).genericBashEmittedBytes.size,
    0,
    'per-tool-call coalescing state is cleaned up with the tool call'
  )
})

test('PiAcpSession: generic bash updates flush mid-stream once growth passes the threshold', async () => {
  const first = 'x'.repeat(50)
  const second = first + 'y'.repeat(100)
  const { updates } = await runBashTurn([first, second, second + 'z'.repeat(10)], {
    content: [{ type: 'text', text: 'done' }]
  })

  assert.deepEqual(
    updates.map(update => [update.status, update.content]),
    [
      ['in_progress', fenced(first)],
      ['in_progress', fenced(second)],
      ['completed', fenced('done')]
    ],
    'each flush carries the full accumulated snapshot, never a delta'
  )
})
