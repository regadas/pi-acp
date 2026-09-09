import test from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
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

function makeSession(
  conn: FakeAgentSideConnection,
  proc: FakePiRpcProcess,
  opts?: { deferredAdmissionTimeoutMs?: number }
): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    ...(opts?.deferredAdmissionTimeoutMs !== undefined
      ? { deferredAdmissionTimeoutMs: opts.deferredAdmissionTimeoutMs }
      : {})
  })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function turnBoundUpdateCount(conn: FakeAgentSideConnection): number {
  return conn.updates.filter(update => TURN_BOUND_UPDATES.has(update.update.sessionUpdate)).length
}

function agentMessageTexts(conn: FakeAgentSideConnection): string[] {
  return conn.updates.flatMap(update => {
    if (update.update.sessionUpdate !== 'agent_message_chunk') return []
    const content = (update.update as { content?: { type?: unknown; text?: unknown } }).content
    return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []
  })
}

function emitForeignTurnBoundEvents(proc: FakePiRpcProcess): void {
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'foreign text' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'foreign thought' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'foreign-tool', toolName: 'read', args: { path: 'x' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'foreign-tool',
    isError: false,
    result: { content: [{ type: 'text', text: 'foreign tool output' }] }
  })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1_000 })
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'foreign retry failed' })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: { summary: 'foreign summary' },
    aborted: false
  })
}

async function assertInternalFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const record = error as { code?: unknown; message?: unknown }
    assert.equal(record.code, -32603)
    assert.match(String(record.message), message)
    return true
  })
}

test('PiAcpSession: an out-of-band run defers dispatch; its settlement admits exactly once without resolving', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, { deferredAdmissionTimeoutMs: 30 })

  proc.emit({ type: 'agent_start' })

  const prompt = session.prompt('hello')
  let resolved = false
  void prompt.then(() => {
    resolved = true
  })

  await tick()
  assert.equal(proc.prompts.length, 0, 'no raw prompt may be dispatched into an out-of-band run')

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(resolved, false, 'foreign settlement must not resolve the ACP turn')
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello'],
    'settlement admits exactly one dispatch'
  )

  await sleep(80)
  assert.equal(proc.prompts.length, 1, 'the cleared admission timer cannot settle or send twice')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: an accepted prompt pi queued does not own foreign extension UI requests', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.beforePromptAccepted = message => {
    // pi queued this prompt as a follow-up to work whose agent_start this
    // session never observed, so the out-of-band gate is down: acceptance
    // alone proves nothing and the queued user message is the only ownership
    // proof.
    proc.emit({ type: 'queue_update', steering: [], followUp: [`expanded:${message}`] })
  }

  const prompt = session.prompt('hello')
  await tick()
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello']
  )

  proc.emit({ type: 'extension_ui_request', id: 'foreign-ui', method: 'confirm', title: 'Foreign?' })
  await tick()
  assert.equal(conn.permissionRequests.length, 0, 'foreign UI must not escape as an ACP permission request')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'foreign-ui', cancelled: true }])
  assert.equal(turnBoundUpdateCount(conn), 0, 'no turn-bound update belongs to the queued prompt yet')

  proc.emit({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'expanded:hello' }] }
  })
  proc.emit({ type: 'extension_ui_request', id: 'owned-ui', method: 'confirm', title: 'Owned?' })
  await tick()
  assert.equal(conn.permissionRequests.length, 1, 'once the queued prompt owns the run, its UI reaches the client')
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'foreign-ui', cancelled: true },
    { id: 'owned-ui', confirmed: false }
  ])

  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: a foreign run buffered before prompt acceptance stays unowned until its queued user message', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.beforePromptAccepted = message => {
    // Real stdout order when pi was already streaming but the adapter had not
    // consumed its start yet: foreign start/output, queue update, then the
    // prompt success response (the fake invokes onAccepted after this hook).
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'queue_update', steering: [], followUp: [`expanded:${message}`] })
    emitForeignTurnBoundEvents(proc)
    proc.emit({
      type: 'message_end',
      message: { role: 'custom', display: true, content: 'Buffered foreign notification.' }
    })
    proc.emit({ type: 'extension_ui_request', id: 'foreign-ui', method: 'confirm', title: 'Foreign?' })
  }

  const prompt = session.prompt('hello')
  await tick()
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello']
  )
  assert.equal(turnBoundUpdateCount(conn), 0, 'pre-response foreign output must remain suppressed')
  assert.equal(conn.permissionRequests.length, 0, 'foreign UI must not escape as an ACP permission request')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'foreign-ui', cancelled: true }])

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still foreign' } })
  assert.equal(turnBoundUpdateCount(conn), 0, 'post-response foreign output remains unowned before the follow-up')

  proc.emit({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'expanded:hello' }] }
  })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned response' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop' } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn', 'foreign done:length and retry failure must not contaminate the turn')
  assert.deepEqual(agentMessageTexts(conn), ['Buffered foreign notification.', 'owned response'])
})

test('PiAcpSession: duplicate foreign follow-ups are skipped before claiming the queued prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.beforePromptAccepted = () => {
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'queue_update', steering: [], followUp: ['same', 'same'] })
  }

  const prompt = session.prompt('same')
  proc.emit({ type: 'queue_update', steering: [], followUp: ['same'] })
  proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'same' }] } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'foreign duplicate' } })
  assert.equal(turnBoundUpdateCount(conn), 0)

  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'same' }] } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned duplicate' } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(agentMessageTexts(conn), ['owned duplicate'])
})

test('PiAcpSession: an image-only queued prompt correlates on its empty text block', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const image = { type: 'image', data: 'aGk=', mimeType: 'image/png' }

  proc.beforePromptAccepted = () => {
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'queue_update', steering: [], followUp: [''] })
  }

  const prompt = session.prompt('', [image])
  proc.emit({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: '' }, image] }
  })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'described image' } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: '', attachments: [image] }])
  assert.deepEqual(agentMessageTexts(conn), ['described image'])
  assert.equal(proc.disposeCount, 0)
})

test('PiAcpSession: an ambiguous nested out-of-band run fails closed without dispatching', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.emit({ type: 'agent_start' })
  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })

  await assertInternalFailure(prompt, /uncorrelatable nested run/)
  assert.equal(proc.prompts.length, 0)
  assert.deepEqual(proc.disposeOptions, [{ expected: false }])

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(proc.prompts.length, 0, 'a stale outer settlement cannot resurrect the failed dispatch')
})

test('PiAcpSession: signalled autonomous retry continuations keep one admission gate', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.emit({ type: 'agent_start' })
  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await tick()

  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello'],
    'the sole AgentSession settlement admits the deferred prompt after its low-level retry'
  )
  assert.equal(proc.disposeCount, 0)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: a queue update before agent_end marks a legitimate autonomous continuation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.emit({ type: 'agent_start' })
  const prompt = session.prompt('hello')
  proc.emit({ type: 'queue_update', steering: [], followUp: ['extension continuation'] })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'extension continuation' }] }
  })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await tick()

  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello']
  )
  assert.equal(proc.disposeCount, 0)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: foreign output is suppressed and custom messages flush only when deferred dispatch begins', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false }
  const session = makeSession(conn, proc)

  proc.emit({ type: 'agent_start' })
  emitForeignTurnBoundEvents(proc)
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'Background completion.' }
  })
  await tick()
  assert.equal(turnBoundUpdateCount(conn), 0, 'foreign output must not escape while ACP is idle')

  const prompt = session.prompt('/extension-handled')
  await tick()
  assert.equal(proc.prompts.length, 0)
  assert.equal(turnBoundUpdateCount(conn), 0, 'foreign output and custom messages stay buffered during admission')

  emitForeignTurnBoundEvents(proc)
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn', 'foreign done:length/failure state cannot affect the no-run prompt')
  assert.equal(proc.prompts.length, 1)
  assert.deepEqual(agentMessageTexts(conn), ['Background completion.'])
})

test('PiAcpSession: FIFO is preserved behind a deferred turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  const second = session.prompt('second')
  await tick()
  assert.equal(proc.prompts.length, 0)

  const queuedNotices = agentMessageTexts(conn).filter(text => text.startsWith('Queued message'))
  assert.equal(queuedNotices.length, 1)

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['first']
  )

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  await tick()
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['first', 'second']
  )

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: cancel while deferred settles locally and suppresses all later foreign output', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  const second = session.prompt('second')
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'Deferred notification.' }
  })
  await tick()

  await session.cancel()
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.abortCount, 0, 'the unrelated out-of-band run must not be aborted')

  const updatesAtCancel = turnBoundUpdateCount(conn)
  emitForeignTurnBoundEvents(proc)
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: true, content: 'Post-cancel notification.' }
  })
  await sleep(60)
  assert.equal(proc.prompts.length, 0, 'the cleared admission timeout cannot dispatch after cancellation')
  assert.equal(turnBoundUpdateCount(conn), updatesAtCancel, 'post-cancel foreign output must not escape')

  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(proc.prompts.length, 0)

  const third = session.prompt('third')
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['third']
  )
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await third, 'end_turn')
  assert.deepEqual(
    agentMessageTexts(conn).filter(text => text.endsWith('notification.')),
    ['Deferred notification.', 'Post-cancel notification.']
  )
})

test('PiAcpSession: unexpected termination while deferred rejects turns and clears admission timeout', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  const second = session.prompt('second')
  await tick()

  proc.emitTermination({ code: 1, signal: null, expected: false, stderrTail: 'boom' })
  await assertInternalFailure(first, /pi process exited unexpectedly/)
  await assertInternalFailure(second, /pi process exited unexpectedly/)

  await sleep(60)
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: expected teardown while deferred cancels turns and clears admission timeout', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  const second = session.prompt('second')
  await tick()

  proc.emitTermination({ expected: true })
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')

  await sleep(60)
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: admission timeout quarantines and rejects without dispatching', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc, { deferredAdmissionTimeoutMs: 20 })

  proc.emit({ type: 'agent_start' })
  const first = session.prompt('first')
  const second = session.prompt('second')

  await assertInternalFailure(first, /Timed out waiting for out-of-band pi work to settle/)
  await assertInternalFailure(second, /Timed out waiting for out-of-band pi work to settle/)
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.disposeCount, 1, 'an uncorrelatable child is quarantined')
  assert.deepEqual(proc.disposeOptions, [{ expected: false }])

  proc.emit({ type: 'agent_settled' })
  await sleep(40)
  assert.equal(proc.prompts.length, 0, 'late settlement cannot resurrect the failed dispatch')
})

test('PiAcpSession: cancel does not abort autonomous work while a completed turn flushes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  let releaseUpdate!: () => void
  const updateGate = new Promise<void>(resolve => {
    releaseUpdate = resolve
  })
  const sendUpdate = conn.sessionUpdate.bind(conn)
  let blockFirstUpdate = true
  conn.sessionUpdate = async update => {
    if (blockFirstUpdate) {
      blockFirstUpdate = false
      await updateGate
    }
    await sendUpdate(update)
  }

  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'agent_start' })

  await session.cancel()
  assert.equal(proc.abortCount, 0, 'the completing turn no longer owns pi work to abort')

  releaseUpdate()
  assert.equal(await prompt, 'end_turn')
  await session.cancel()
  assert.equal(proc.abortCount, 0, 'idle cancellation is local and must not abort autonomous work')

  proc.emit({ type: 'agent_settled' })
})

test(
  'PiAcpSession: autonomous run during completion flush gates the next queued prompt',
  { timeout: 2_000 },
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
    conn.sessionUpdate = async update => {
      if (blockFirstUpdate) {
        blockFirstUpdate = false
        await firstUpdateGate
      }
      await sendUpdate(update)
    }

    const first = session.prompt('first')
    proc.emit({ type: 'agent_start' })
    const second = session.prompt('second')
    proc.emit({ type: 'agent_settled' })

    // A new autonomous run starts while first remains installed solely to flush
    // updates. It must not be attributed to the completing turn.
    proc.emit({ type: 'agent_start' })
    emitForeignTurnBoundEvents(proc)
    proc.emit({ type: 'extension_ui_request', id: 'flush-ui', method: 'select', options: ['A'] })
    await tick()
    assert.equal(conn.permissionRequests.length, 0)
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'flush-ui', cancelled: true }])
    releaseFirstUpdate()

    assert.equal(await first, 'end_turn')
    await tick()
    assert.deepEqual(
      proc.prompts.map(item => item.message),
      ['first']
    )

    proc.emit({ type: 'agent_settled' })
    await tick()
    assert.deepEqual(
      proc.prompts.map(item => item.message),
      ['first', 'second']
    )

    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.equal(await second, 'end_turn')
    assert.ok(!agentMessageTexts(conn).includes('foreign text'))
  }
)

for (const late of [false, true]) {
  test(`PiAcpSession: ${late ? 'late' : 'initial'} identical steering quarantines follow-up ownership`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)
    proc.beforePromptAccepted = () => {
      proc.emit({ type: 'agent_start' })
      proc.emit({
        type: 'queue_update',
        steering: late ? [] : ['same'],
        followUp: ['same']
      })
    }
    const prompt = session.prompt('same')
    const failed = assertInternalFailure(prompt, /steering text indistinguishable/)
    if (late)
      proc.emit({
        type: 'queue_update',
        steering: ['same'],
        followUp: ['same']
      })
    // Installed pi removes steering before message_start; that removal must
    // never erase evidence of the earlier collision.
    proc.emit({ type: 'queue_update', steering: [], followUp: ['same'] })
    proc.emit({
      type: 'message_start',
      message: { role: 'user', content: 'same' }
    })
    emitForeignTurnBoundEvents(proc)
    proc.emit({
      type: 'extension_ui_request',
      id: 'foreign',
      method: 'confirm',
      title: 'Foreign?'
    })
    proc.emit({ type: 'agent_settled' })
    await failed
    assert.equal(turnBoundUpdateCount(conn), 0)
    assert.equal(conn.permissionRequests.length, 0)
    assert.deepEqual(proc.disposeOptions, [{ expected: false }])
  })
}

for (const [timing, message, expanded] of [
  ['during dispatch', 'same', 'same'],
  ['during dispatch', '/template', 'expanded template'],
  ['before dispatch', '/template', 'expanded template'],
  ['before dispatch', '', '']
]) {
  test(`PiAcpSession: dequeued steering ${timing} cannot claim queued ${JSON.stringify(message)}`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)
    const dequeueSteering = () => {
      proc.emit({ type: 'queue_update', steering: [expanded], followUp: [] })
      proc.emit({ type: 'queue_update', steering: [], followUp: [] })
    }
    if (timing === 'before dispatch') dequeueSteering()
    proc.beforePromptAccepted = () => {
      proc.emit({ type: 'agent_start' })
      if (timing === 'during dispatch') dequeueSteering()
      proc.emit({ type: 'queue_update', steering: [], followUp: [expanded] })
    }
    const prompt = session.prompt(message)
    const failed = assertInternalFailure(prompt, /steering text indistinguishable/)
    // Pi awaits extension handlers between dequeue and public message_start.
    proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: expanded }] } })
    emitForeignTurnBoundEvents(proc)
    proc.emit({ type: 'extension_ui_request', id: 'delayed-steering', method: 'confirm', title: 'Foreign?' })
    proc.emit({ type: 'agent_settled' })
    await failed
    assert.equal(turnBoundUpdateCount(conn), 0)
    assert.equal(conn.permissionRequests.length, 0)
    assert.deepEqual(proc.disposeOptions, [{ expected: false }])
  })
}

test('PiAcpSession: steering evidence ends at settlement, not the next ACP dispatch', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const first = session.prompt('first')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'queue_update', steering: ['same'], followUp: [] })
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'same' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')

  proc.beforePromptAccepted = () => {
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'queue_update', steering: [], followUp: ['same', 'same'] })
  }
  const second = session.prompt('same')
  proc.emit({ type: 'queue_update', steering: [], followUp: ['same'] })
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'same' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'foreign duplicate' } })
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'same' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned duplicate' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
  assert.deepEqual(agentMessageTexts(conn), ['owned duplicate'])
  assert.equal(proc.disposeCount, 0)
})
