import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}
function texts(conn: FakeAgentSideConnection) {
  return conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  )
}

test('responsiveness: autonomous progress is visible before input and cannot determine its result', async () => {
  const { conn, proc, session } = harness()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'autonomous progress' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'background-read', toolName: 'read', args: { path: 'x' } })
  await tick()
  assert.ok(texts(conn).includes('autonomous progress'))
  assert.ok(
    conn.updates.some(({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'background-read')
  )
  const prompt = session.prompt('ordinary question')
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length' } })
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'unrelated failure' })
  proc.emit({ type: 'agent_settled' })
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned answer' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.ok(texts(conn).includes('owned answer'))
})

test('responsiveness: native settlement releases foreground while its child stays live', async () => {
  const { proc, session } = harness()
  const launch = session.prompt('launch')
  proc.emit({ type: 'agent_start' })
  const owner = (session as unknown as { pendingTurn: { owner: string } }).pendingTurn.owner
  proc.emit({
    type: 'extension_ui_request',
    id: 'active',
    method: 'setWidget',
    widgetKey: 'pi-acp-lifecycle',
    widgetLines: [JSON.stringify({ version: 1, owner, state: 'active' })]
  })
  let settled = false
  void launch.then(() => {
    settled = true
  })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(settled, true, 'child liveness is not foreground model ownership')
  assert.equal(await launch, 'end_turn')
  const question = session.prompt('ordinary question')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await question, 'end_turn')
  assert.equal(proc.abortCount, 0)
})

test('responsiveness: healthy autonomous work survives the former ten-minute admission deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { conn, proc, session } = harness()
  proc.emit({ type: 'agent_start' })
  const prompt = session.prompt('ordinary question')
  const outcome = prompt.then(
    value => value,
    error => error
  )
  await tick()
  assert.ok(
    texts(conn).some(text => /queued|waiting/i.test(text)),
    'busy admission must be visible'
  )
  t.mock.timers.tick(10 * 60_000 + 1)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still progressing' } })
  await tick()
  assert.equal(proc.disposed, false)
  await session.cancel()
  assert.equal(await outcome, 'cancelled')
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.disposed, false)
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(proc.prompts.length, 0, 'late readiness must not dispatch withdrawn input')
})

test('responsiveness: autonomous tool cards survive staged cancellation and close only on their own end or channel death', async () => {
  const { conn, proc, session } = harness()
  const statuses = (id: string) =>
    conn.updates.flatMap(({ update }) =>
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      update.toolCallId === id &&
      update.status
        ? [update.status]
        : []
    )
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'autonomous-read', toolName: 'read', args: { path: 'x' } })
  const staged = session.prompt('ordinary question')
  await tick()
  assert.equal(statuses('autonomous-read').at(-1), 'in_progress')
  await session.cancel()
  assert.equal(await staged, 'cancelled')
  assert.deepEqual(statuses('autonomous-read'), ['in_progress'], 'unrelated foreground cannot terminalize this card')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'autonomous-read',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'done' }] },
    isError: false
  })
  await tick()
  assert.deepEqual(statuses('autonomous-read'), ['in_progress', 'completed'])
  proc.emit({ type: 'tool_execution_start', toolCallId: 'autonomous-open', toolName: 'read', args: { path: 'y' } })
  await tick()
  assert.equal(statuses('autonomous-open').at(-1), 'in_progress')
  proc.emitTermination({ reason: 'exit', code: 1, expected: false })
  await tick()
  assert.deepEqual(
    statuses('autonomous-open'),
    ['in_progress', 'failed'],
    'channel death closes remaining autonomous cards'
  )
})

for (const admission of ['idle', 'staged', 'cancelled'] as const) {
  test(`responsiveness: partial autonomous tool cards terminalize at their own settlement: ${admission}`, async () => {
    const { conn, proc, session } = harness()
    const statuses = (id: string) =>
      conn.updates.flatMap(({ update }) =>
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        update.toolCallId === id &&
        update.status
          ? [update.status]
          : []
      )
    proc.emit({ type: 'agent_start' })
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'autonomous-partial', toolName: 'write' }
    })
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' }
    })
    const prompt = admission === 'idle' ? undefined : session.prompt('ordinary question')
    if (admission === 'cancelled') {
      await session.cancel()
      assert.equal(await prompt, 'cancelled')
    }
    await tick()
    assert.deepEqual(
      statuses('autonomous-partial'),
      ['pending', 'pending'],
      'staged cancellation cannot close the foreign card'
    )
    const cardPresentAtDispatch: boolean[] = []
    const dispatch = proc.prompt.bind(proc)
    proc.prompt = async (...args) => {
      cardPresentAtDispatch.push(
        (session as unknown as { currentToolCalls: Map<string, string> }).currentToolCalls.has('autonomous-partial')
      )
      await dispatch(...args)
    }
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'foreign stream ended' } }
    })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length' } })
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await tick()
    assert.deepEqual(statuses('autonomous-partial'), ['pending', 'pending', 'failed'])
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, id: 'autonomous-partial', delta: 'late' }
    })
    if (admission === 'staged') {
      assert.deepEqual(cardPresentAtDispatch, [false], 'old card bookkeeping retires before replacement dispatch')
      assert.equal(proc.prompts.length, 1)
      proc.emit({ type: 'agent_start' })
      proc.emit({ type: 'tool_execution_start', toolCallId: 'owned-read', toolName: 'read', args: { path: 'x' } })
      proc.emit({
        type: 'tool_execution_end',
        toolCallId: 'owned-read',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false
      })
      proc.emit({ type: 'agent_settled' })
      assert.equal(await prompt, 'end_turn', 'autonomous failure and length cannot determine replacement outcome')
      assert.deepEqual(statuses('owned-read'), ['in_progress', 'completed'])
      const terminal = conn.updates.findIndex(
        ({ update }) =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'autonomous-partial' &&
          update.status === 'failed'
      )
      const owned = conn.updates.findIndex(
        ({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'owned-read'
      )
      assert.ok(terminal >= 0 && owned > terminal, 'old card terminal update precedes replacement progress')
    } else assert.equal(proc.prompts.length, 0)
    await tick()
    assert.deepEqual(
      statuses('autonomous-partial'),
      ['pending', 'pending', 'failed'],
      'late partial delta cannot resurrect the card'
    )
    assert.equal(proc.disposed, false)
  })
}
