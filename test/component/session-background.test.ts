import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { asAgentConn, FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function harness() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({ sessionId: 's', cwd: '/tmp', proc: proc as any, conn: asAgentConn(conn) })
  const lifecycle = (state: string, owner = (session as any).pendingTurn.owner) =>
    proc.emit({
      type: 'extension_ui_request',
      id: 'lifecycle',
      method: 'setWidget',
      widgetKey: 'pi-acp-lifecycle',
      widgetLines: [JSON.stringify({ version: 1, owner, state })]
    })
  return { conn, proc, session, lifecycle }
}

test('owned background settlement releases FIFO and later synthesis is session-scoped', async () => {
  const { conn, proc, session, lifecycle } = harness()
  const first = session.prompt('launch')
  proc.emit({ type: 'agent_start' })
  const owner = (session as any).pendingTurn.owner
  lifecycle('active', owner)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'synthesis' } })
  lifecycle('idle', owner)
  await tick()
  assert.ok(
    conn.updates.some(
      n =>
        n.update.sessionUpdate === 'agent_message_chunk' &&
        n.update.content.type === 'text' &&
        n.update.content.text === 'synthesis'
    )
  )
  const second = session.prompt('next')
  await tick()
  assert.equal(proc.prompts.length, 1, 'current model run, not the child pipeline, stages input')
  proc.emit({ type: 'agent_settled' })
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('summarization progress stays owned and does not settle the prompt', async () => {
  const { conn, proc, session } = harness()
  const prompt = session.prompt('compact')
  proc.emit({ type: 'agent_start' })
  for (const type of [
    'summarization_retry_scheduled',
    'summarization_retry_attempt_start',
    'summarization_retry_finished'
  ])
    proc.emit({ type, attempt: 1, maxAttempts: 3, delayMs: 10 })
  let settled = false
  void prompt.then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, false)
  assert.equal(conn.updates.filter(n => n.update.sessionUpdate === 'agent_message_chunk').length, 3)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('background failures are visible and quarantine instead of releasing delayed work as success', async () => {
  const { conn, proc, session, lifecycle } = harness()
  const prompt = session.prompt('launch')
  proc.emit({ type: 'agent_start' })
  lifecycle('active')
  lifecycle('error')
  await assert.rejects(prompt, /Background harness/)
  assert.equal(proc.disposed, true)
  assert.ok(conn.updates.some(n => n.update.sessionUpdate === 'agent_message_chunk'))
})

test('background cancellation forwards the exact owner and cancels FIFO', async () => {
  const { proc, session, lifecycle } = harness()
  const prompt = session.prompt('launch')
  const queued = session.prompt('next')
  proc.emit({ type: 'agent_start' })
  lifecycle('active')
  const owner = (session as any).pendingTurn.owner
  const cancel = session.cancel()
  await tick()
  assert.deepEqual(proc.abortOwners, [owner])
  proc.emit({ type: 'agent_settled' })
  lifecycle('idle', owner)
  await cancel
  assert.equal(await prompt, 'cancelled')
  assert.equal(await queued, 'cancelled')
})

for (const rejectProbe of [false, true]) {
  test(`native settlement releases background foreground despite a late ${rejectProbe ? 'failed' : 'idle'} acceptance probe`, async () => {
    const { proc, session, lifecycle } = harness()
    let resolve!: (state: unknown) => void
    let reject!: (error: Error) => void
    proc.getState = () =>
      new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    const prompt = session.prompt('launch')
    await tick()
    proc.emit({ type: 'agent_start' })
    lifecycle('active')
    proc.getState = async () => ({ isStreaming: false })
    proc.emit({ type: 'agent_settled' })
    if (rejectProbe) reject(new Error('late probe'))
    else resolve({ isStreaming: false })
    await tick()
    assert.equal(proc.disposed, false)
    assert.equal((session as any).pendingTurn, null)
    proc.getState = async () => ({ isStreaming: false })
    lifecycle('idle', 'released-owner')
    assert.equal(await prompt, 'end_turn')
  })
}

for (const failure of [false, true]) {
  test(`late background activation during native cancel retains owner and FIFO (${failure})`, async () => {
    const { conn, proc, session, lifecycle } = harness()
    let finishAbort!: () => void
    proc.abort = owner => {
      proc.abortOwners.push(owner)
      return new Promise(resolve => {
        finishAbort = resolve
      })
    }
    const prompt = session.prompt('launch')
    const result = prompt.then(
      value => value,
      error => error
    )
    const queued = session.prompt('next')
    proc.emit({ type: 'agent_start' })
    const owner = (session as any).pendingTurn.owner
    const cancel = session.cancel()
    lifecycle('active')
    proc.emit({ type: 'agent_settled' })
    if (failure) lifecycle('error')
    finishAbort()
    await cancel
    assert.deepEqual(proc.abortOwners, [owner])
    assert.equal(await result, 'cancelled')
    assert.equal(await queued, 'cancelled')
    if (failure) assert.ok(conn.updates.some(n => n.update.sessionUpdate === 'agent_message_chunk'))
  })
}

test('cancellation bridge rejection without a widget remains visible and cancelled', async () => {
  const { conn, proc, session } = harness()
  proc.abort = async () => {
    throw new Error('termination could not be confirmed')
  }
  const prompt = session.prompt('launch')
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.disposed, true)
  assert.ok(
    conn.updates.some(
      n =>
        n.update.sessionUpdate === 'agent_message_chunk' &&
        n.update.content.type === 'text' &&
        n.update.content.text.includes('termination could not be confirmed')
    )
  )
})

test('cancellation widget failure cannot settle before the abort transaction reports uncertainty', async () => {
  const { conn, proc, session, lifecycle } = harness()
  let rejectAbort!: (error: Error) => void
  proc.abort = () =>
    new Promise((_resolve, reject) => {
      rejectAbort = reject
    })
  let settled = false
  const prompt = session.prompt('launch').then(result => {
    settled = true
    return result
  })
  proc.emit({ type: 'agent_start' })
  lifecycle('active')
  const cancellation = session.cancel()
  lifecycle('error')
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(settled, false)
  assert.equal(proc.disposed, false)
  rejectAbort(new Error('quiescence unknown'))
  await cancellation
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.disposed, true)
  assert.ok(
    conn.updates.some(
      n =>
        n.update.sessionUpdate === 'agent_message_chunk' &&
        n.update.content.type === 'text' &&
        n.update.content.text.includes('detached work may still be running')
    )
  )
})

for (const action of ['shutdown', 'dispose'] as const) {
  test(`native-settled completion flushing keeps children detached during ${action}`, async () => {
    const { conn, proc, session, lifecycle } = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const deliver = conn.sessionUpdate.bind(conn)
    conn.sessionUpdate = async message => {
      await gate
      await deliver(message)
    }
    const prompt = session.prompt('launch')
    let settled = false
    void prompt.then(() => {
      settled = true
    })
    proc.emit({ type: 'agent_start' })
    const owner = (session as unknown as { pendingTurn: { owner: string } }).pendingTurn.owner
    lifecycle('active', owner)
    proc.emit({ type: 'agent_settled' })
    let shutdown: Promise<void> | undefined
    try {
      await tick()
      assert.equal(settled, false, 'ACP completion is still flushing after native settlement')
      if (action === 'shutdown') {
        shutdown = session.shutdown()
        assert.equal(session.shutdown(), shutdown, 'shutdown remains idempotent')
        await tick()
        assert.deepEqual(proc.abortOwners, [undefined], 'native-only teardown cannot reclaim the detached owner')
        session.dispose()
      } else {
        session.dispose()
      }
      session.dispose()
      const options = proc.disposeOptions as Array<{ expected?: boolean; backgroundOwner?: string }>
      assert.deepEqual(options, [{ expected: true }], 'disposal cannot reclaim the detached owner either')
    } finally {
      release()
      await shutdown
      assert.equal(await prompt, 'end_turn', 'late teardown does not rewrite native-completed outcome')
    }
  })
}

for (const cancellationPending of [false, true]) {
  test(`disposal retains exact foreground ownership with native cancellation pending: ${cancellationPending}`, async () => {
    const { proc, session, lifecycle } = harness()
    proc.terminateOnDispose = true
    let finishAbort!: () => void
    proc.abort = owner => {
      proc.abortOwners.push(owner)
      return new Promise<void>(resolve => {
        finishAbort = resolve
      })
    }
    const prompt = session.prompt('launch')
    proc.emit({ type: 'agent_start' })
    const owner = (session as unknown as { pendingTurn: { owner: string } }).pendingTurn.owner
    lifecycle('active', owner)
    const cancellation = cancellationPending ? session.cancel() : undefined
    if (cancellationPending) proc.emit({ type: 'agent_settled' })
    session.dispose()
    const options = proc.disposeOptions as Array<{ expected?: boolean; backgroundOwner?: string }>
    assert.deepEqual(options, [{ expected: true, backgroundOwner: owner }])
    if (cancellationPending) finishAbort()
    await cancellation
    assert.equal(await prompt, 'cancelled')
  })
}

test('shutdown retains the turn until native and late owned cancellation finish', async () => {
  const { proc, session, lifecycle } = harness()
  let finishAbort!: () => void
  proc.abort = owner => {
    proc.abortOwners.push(owner)
    return new Promise(resolve => {
      finishAbort = resolve
    })
  }
  const prompt = session.prompt('launch')
  let settled = false
  void prompt.then(() => {
    settled = true
  })
  proc.emit({ type: 'agent_start' })
  const shutdown = session.shutdown()
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(settled, false)
  lifecycle('active')
  finishAbort()
  await shutdown
  assert.equal(await prompt, 'cancelled')
})
