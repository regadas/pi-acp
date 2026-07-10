import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const TURN_BOUND_UPDATES = new Set([
  'tool_call',
  'tool_call_update',
  'agent_thought_chunk',
  'agent_message_chunk',
  'user_message_chunk',
  'plan'
])

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: retry/continuation updates after agent_end stay in-turn and are flushed before resolution', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  let resolved = false
  let updatesAtResolve = -1
  const tracked = p.then(reason => {
    resolved = true
    updatesAtResolve = conn.updates.length
    return reason
  })

  // First low-level agent run fails and ends.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  await tick()
  assert.equal(resolved, false, 'ACP prompt must not resolve at the first agent_end')

  // pi auto-retries and continues the same prompt with more thought/tool work.
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000 })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'still thinking' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.txt' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  await tick()
  assert.equal(resolved, false, 'ACP prompt must stay open through retries/continuations')

  proc.emit({ type: 'agent_settled' })
  const reason = await tracked
  assert.equal(reason, 'end_turn')

  // Every update emitted during the whole run (including post-agent_end
  // continuation updates) must have been delivered before the ACP response.
  const kinds = conn.updates.map(u => u.update.sessionUpdate)
  const expectedInOrder = [
    'agent_message_chunk', // 'partial '
    'agent_message_chunk', // retry notice
    'agent_thought_chunk', // 'still thinking'
    'tool_call', // t1 start
    'tool_call_update' // t1 end
  ]
  const turnBound = kinds.filter(k => TURN_BOUND_UPDATES.has(k))
  assert.deepEqual(turnBound, expectedInOrder)
  assert.equal(
    updatesAtResolve,
    conn.updates.length,
    'all session/update notifications must be flushed before the prompt resolves'
  )
})

test(
  'PiAcpSession: prompts arriving during completion flush remain FIFO and no pending turn is overwritten',
  { timeout: 2000 },
  async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)

    let releaseFirstUpdate!: () => void
    const firstUpdateGate = new Promise<void>(resolve => {
      releaseFirstUpdate = resolve
    })
    const sendUpdate = conn.sessionUpdate.bind(conn)
    let blockFirstUpdate = true
    conn.sessionUpdate = async msg => {
      if (blockFirstUpdate) {
        blockFirstUpdate = false
        await firstUpdateGate
      }
      await sendUpdate(msg)
    }

    const first = session.prompt('first')
    proc.emit({ type: 'agent_start' })
    const second = session.prompt('second')

    // Completion begins while the first notification is deliberately blocked.
    // A third request arriving now must queue behind the already-queued second
    // request rather than starting and being overwritten when the flush ends.
    proc.emit({ type: 'agent_settled' })
    const third = session.prompt('third')
    await tick()
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first'],
      'no later prompt may reach pi while the completing turn is flushing'
    )

    releaseFirstUpdate()
    assert.equal(await first, 'end_turn')
    await tick()
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first', 'second']
    )

    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.equal(await second, 'end_turn')
    await tick()
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first', 'second', 'third']
    )

    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.equal(await third, 'end_turn')
  }
)

test(
  'PiAcpSession: prompt failure drains queued requests after flushing their updates without auto-starting them',
  { timeout: 2000 },
  async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)

    let releaseFirstUpdate!: () => void
    const firstUpdateGate = new Promise<void>(resolve => {
      releaseFirstUpdate = resolve
    })
    const sendUpdate = conn.sessionUpdate.bind(conn)
    let blockFirstUpdate = true
    conn.sessionUpdate = async msg => {
      if (blockFirstUpdate) {
        blockFirstUpdate = false
        await firstUpdateGate
      }
      await sendUpdate(msg)
    }

    let rejectFirstPrompt!: (error: Error) => void
    proc.prompt = (message, attachments = []) => {
      proc.prompts.push({ message, attachments })
      if (message !== 'first') return Promise.resolve()
      return new Promise<void>((_resolve, reject) => {
        rejectFirstPrompt = reject
      })
    }

    const first = session.prompt('first')
    const second = session.prompt('second')
    rejectFirstPrompt(new Error('pi prompt failed'))
    await tick()

    // failTurn is now waiting on the blocked first update. This request must
    // join the failure drain along with the already-queued second request.
    const third = session.prompt('third')
    let settled = false
    let turnBoundAtSettle = -1
    const all = Promise.all([first, second, third]).then(reasons => {
      settled = true
      turnBoundAtSettle = conn.updates.filter(update => TURN_BOUND_UPDATES.has(update.update.sessionUpdate)).length
      return reasons
    })

    await tick()
    assert.equal(settled, false, 'failed and queued requests must wait for queued notifications to flush')
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first']
    )

    releaseFirstUpdate()
    assert.deepEqual(await all, ['error', 'error', 'error'])
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first'],
      'queued prompts must not auto-run'
    )

    const queuedNotices = conn.updates.filter(
      update =>
        update.update.sessionUpdate === 'agent_message_chunk' &&
        (update.update as any).content?.text?.startsWith('Queued message')
    )
    assert.equal(queuedNotices.length, 2, 'both queued notifications must be delivered before responses settle')

    await tick()
    assert.equal(
      conn.updates.filter(update => TURN_BOUND_UPDATES.has(update.update.sessionUpdate)).length,
      turnBoundAtSettle,
      'no queued turn-bound notification may arrive after the drained responses'
    )

    const fourth = session.prompt('fourth')
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first', 'fourth']
    )
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.equal(await fourth, 'end_turn', 'a fresh prompt can start after the failed queue is drained')
  }
)

test('PiAcpSession: cancellation resolves cancelled at agent_settled with no turn-bound update after the response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  let resolved = false
  let updatesAtResolve = -1
  const tracked = p.then(reason => {
    resolved = true
    updatesAtResolve = conn.updates.length
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working...' } })

  await session.cancel()
  assert.equal(proc.abortCount, 1)

  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  await tick()
  assert.equal(resolved, false, 'cancellation must still resolve only at the settled boundary')

  proc.emit({ type: 'agent_settled' })
  const reason = await tracked
  assert.equal(reason, 'cancelled')

  await tick()
  const afterResponse = conn.updates.slice(updatesAtResolve).map(u => u.update.sessionUpdate)
  assert.deepEqual(
    afterResponse.filter(k => TURN_BOUND_UPDATES.has(k)),
    [],
    'no turn-bound session/update may be sent after the cancelled response'
  )
})

test('PiAcpSession: accepted prompt with no agent run completes without hanging', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // pi handled the prompt immediately (extension command / input hook):
  // the RPC acceptance response arrives, no agent events ever follow.
  proc.state = { isStreaming: false }
  const session = makeSession(conn, proc)

  const reason = await session.prompt('/extension-handled')
  assert.equal(reason, 'end_turn')
  assert.equal(proc.prompts.length, 1)

  const turnBound = conn.updates.map(u => u.update.sessionUpdate).filter(k => TURN_BOUND_UPDATES.has(k))
  assert.deepEqual(turnBound, [], 'no synthetic turn-bound updates for a no-run prompt')
})

test('PiAcpSession: acceptance probe keeps the turn open while a run is active', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // Default fake state reports an active run (isStreaming: true) even though
  // agent_start has not been observed yet (in-flight event).
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  let resolved = false
  void p.then(() => {
    resolved = true
  })

  // Let the acceptance handler and its get_state probe fully settle.
  await tick()
  await tick()
  assert.equal(resolved, false, 'isStreaming=true must keep the turn open until agent_settled')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: agent_settled without a pending turn is ignored', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  makeSession(conn, proc)

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.deepEqual(conn.updates, [])
})

test('PiAcpSession: forwards compaction_start and compaction_end (success and failure) in-turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'compaction_start', reason: 'overflow' })
  proc.emit({
    type: 'compaction_end',
    reason: 'overflow',
    result: null,
    aborted: false,
    errorMessage: 'quota exceeded'
  })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({ type: 'compaction_end', reason: 'threshold', result: { summary: 's' }, aborted: false })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await p, 'end_turn')

  const texts = conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text)
  assert.deepEqual(texts, [
    'Context overflow; compacting to recover...',
    'Compaction failed: quota exceeded',
    'Context nearing limit; compacting...',
    'Compaction finished; context was summarized to continue the session.'
  ])
})
