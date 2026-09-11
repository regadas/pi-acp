import test from 'node:test'
import assert from 'node:assert/strict'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('pending extension permissions cancel exactly once and ignore late replies', async () => {
  const conn = new FakeAgentSideConnection()
  const resolvers: Array<(value: any) => void> = []
  const signals: AbortSignal[] = []
  conn.requestPermission = async (_params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
    if (options?.cancellationSignal) signals.push(options.cancellationSignal)
    return new Promise(resolve => resolvers.push(resolve))
  }
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({ sessionId: 'ui', cwd: '/tmp', proc: proc as any, conn: asAgentConn(conn) })

  proc.emit({ type: 'extension_ui_request', id: 'one', method: 'select', options: ['a', 'b'] })
  proc.emit({ type: 'extension_ui_request', id: 'two', method: 'confirm' })
  await tick()
  assert.equal(resolvers.length, 2)

  await session.cancel()
  assert.ok(signals.every(signal => signal.aborted))
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'one', cancelled: true },
    { id: 'two', cancelled: true }
  ])

  resolvers[0]!({ outcome: { outcome: 'selected', optionId: 'choice-0' } })
  resolvers[1]!({ outcome: { outcome: 'selected', optionId: 'yes' } })
  await tick()
  assert.equal(proc.extensionUiResponses.length, 2)
  assert.deepEqual(
    conn.updates.map(notification => notification.update),
    [
      { sessionUpdate: 'tool_call_update', toolCallId: 'pi-ui-one', status: 'completed' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'pi-ui-two', status: 'completed' }
    ]
  )
})

test('negotiated input elicitation returns a string and unnegotiated input cancels', async () => {
  const conn = new FakeAgentSideConnection()
  conn.createElicitation = async () => ({ action: 'accept', content: { value: 'typed value' } }) as any
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 'elicited',
    cwd: '/tmp',
    proc: proc as any,
    conn: asAgentConn(conn),
    supportsElicitationForm: true
  })
  proc.emit({ type: 'extension_ui_request', id: 'input', method: 'input', prefill: 'x' })
  await tick()
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'input', value: 'typed value' }])

  const proc2 = new FakePiRpcProcess()
  new PiAcpSession({ sessionId: 'no-form', cwd: '/tmp', proc: proc2 as any, conn: asAgentConn(conn) })
  proc2.emit({ type: 'extension_ui_request', id: 'editor', method: 'editor' })
  await tick()
  assert.deepEqual(proc2.extensionUiResponses, [{ id: 'editor', cancelled: true }])
  assert.deepEqual(conn.updates, [], 'forms do not create synthetic tool cards')
})

for (const scenario of [
  { method: 'select', optionId: 'choice-0', status: 'in_progress', reply: { value: 'a' } },
  { method: 'confirm', optionId: 'yes', status: 'in_progress', reply: { confirmed: true } },
  { method: 'confirm', optionId: 'no', status: 'rejected', reply: { confirmed: false } },
  { method: 'select', optionId: 'invalid', status: 'in_progress', reply: { cancelled: true } },
  { method: 'confirm', optionId: null, status: 'cancelled', reply: { cancelled: true } },
  { method: 'confirm', optionId: 'error', status: 'waiting', reply: { cancelled: true } }
]) {
  test(`synthetic ${scenario.method} card completes after ${scenario.optionId ?? 'cancel'} in the Zed permission model`, async () => {
    const conn = new FakeAgentSideConnection()
    const states: string[] = []
    let cardId: string | undefined
    // Zed acp_thread.rs: request_tool_call_authorization upserts the card;
    // authorize_tool_call leaves allowed/action choices in progress, not completed.
    conn.requestPermission = async raw => {
      const request = raw as RequestPermissionRequest
      cardId = request.toolCall.toolCallId
      states.push('waiting')
      if (scenario.optionId === 'error') throw new Error('client request failed')
      states.push(scenario.status)
      return scenario.optionId === null
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: scenario.optionId } }
    }
    const deliver = conn.sessionUpdate.bind(conn)
    conn.sessionUpdate = async notification => {
      const update = notification.update
      assert.equal(update.sessionUpdate, 'tool_call_update', 'permission request itself creates the card')
      if (update.sessionUpdate === 'tool_call_update') {
        assert.equal(update.toolCallId, cardId)
        states.push(update.status!)
      }
      await deliver(notification)
    }
    const proc = new FakePiRpcProcess()
    new PiAcpSession({ sessionId: 'ui', cwd: '/tmp', proc: proc as unknown as PiRpcProcess, conn: asAgentConn(conn) })
    proc.emit({ type: 'extension_ui_request', id: 'dialog', method: scenario.method, options: ['a', 'b'] })
    await tick()
    assert.deepEqual(
      states,
      scenario.optionId === 'error' ? ['waiting', 'completed'] : ['waiting', scenario.status, 'completed']
    )
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'dialog', ...scenario.reply }])
    assert.equal(conn.updates.length, 1)
  })
}

for (const settlement of ['duplicate', 'dispose', 'termination', 'shutdown'] as const) {
  test(`synthetic permission ${settlement} completes once and ignores late replies`, async () => {
    const conn = new FakeAgentSideConnection()
    let reply!: (response: RequestPermissionResponse) => void
    let requests = 0
    conn.requestPermission = () => {
      requests += 1
      return new Promise(resolve => {
        reply = resolve
      })
    }
    const proc = new FakePiRpcProcess()
    const session = new PiAcpSession({
      sessionId: 'ui',
      cwd: '/tmp',
      proc: proc as unknown as PiRpcProcess,
      conn: asAgentConn(conn)
    })
    const event = { type: 'extension_ui_request', id: 'dialog', method: 'confirm' }
    proc.emit(event)
    if (settlement === 'duplicate') proc.emit(event)
    else if (settlement === 'dispose') session.dispose()
    else if (settlement === 'termination') proc.emitTermination()
    else await session.shutdown()
    reply({ outcome: { outcome: 'selected', optionId: 'yes' } })
    await tick()
    assert.equal(requests, 1)
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'dialog', cancelled: true }])
    assert.deepEqual(
      conn.updates.map(notification => notification.update),
      [{ sessionUpdate: 'tool_call_update', toolCallId: 'pi-ui-dialog', status: 'completed' }]
    )
  })
}

test('synthetic permission completion flushes before a cancelled active prompt settles', async () => {
  const conn = new FakeAgentSideConnection()
  conn.requestPermission = () => new Promise(() => {})
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'ui',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'dialog', method: 'confirm' })
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const deliver = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'tool_call_update') await gate
    await deliver(notification)
  }
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  let resolved = false
  void prompt.then(() => {
    resolved = true
  })
  await tick()
  assert.equal(resolved, false, 'prompt waits for terminal UI delivery')
  release()
  assert.equal(await prompt, 'cancelled')
  assert.ok(
    conn.updates.some(
      notification =>
        notification.update.sessionUpdate === 'tool_call_update' && notification.update.status === 'completed'
    )
  )
})

test('foreign permission requests and cancelled forms never terminalize synthetic tools', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'ui',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    supportsElicitationForm: true
  })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'foreign', method: 'confirm' })
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'extension_ui_request', id: 'form', method: 'editor' })
  await tick()
  await session.cancel()
  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'foreign', cancelled: true },
    { id: 'form', cancelled: true }
  ])
  assert.deepEqual(conn.updates, [])
})
