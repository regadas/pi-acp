import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import type { AcpClient } from '../../src/acp/client.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function pendingDialog(method: 'select' | 'confirm' | 'input' | 'editor') {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const signals: AbortSignal[] = []
  let answer!: () => void
  const client: AcpClient = {
    sessionUpdate: notification => conn.sessionUpdate(notification),
    requestPermission: (params, options) => {
      conn.permissionRequests.push(params)
      signals.push(options!.cancellationSignal!)
      return new Promise<RequestPermissionResponse>(resolve => {
        answer = () => resolve({ outcome: { outcome: 'selected', optionId: method === 'select' ? 'choice-0' : 'yes' } })
      })
    },
    createElicitation: (_params, options) => {
      signals.push(options!.cancellationSignal!)
      return new Promise<CreateElicitationResponse>(resolve => {
        answer = () => resolve({ action: 'accept', content: { value: 'typed' } })
      })
    }
  }
  const session = new PiAcpSession({
    sessionId: 'deadline',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: client,
    supportsElicitationForm: true
  })
  return {
    conn,
    proc,
    session,
    signals,
    answer: () => answer(),
    emit: (timeout: unknown = 25) =>
      proc.emit({ type: 'extension_ui_request', id: 'dialog', method, options: ['a'], timeout }),
    pendingCount: () => (session as unknown as { pendingUiRequests: Map<string, unknown> }).pendingUiRequests.size
  }
}

for (const method of ['select', 'confirm', 'input', 'editor'] as const) {
  test(`native ${method} expiry cancels ACP, forgets the dialog and ignores a late answer without writing to pi`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = pendingDialog(method)
    t.after(() => h.session.dispose())
    h.emit()
    await flush()
    assert.equal(h.signals.length, 1)
    assert.equal(h.signals[0]!.aborted, false)
    t.mock.timers.tick(25)
    await flush()
    assert.equal(h.signals[0]!.aborted, true, 'native deadline aborts the client request')
    assert.equal(h.pendingCount(), 0)
    assert.deepEqual(h.proc.extensionUiResponses, [], 'native expiry already resolved its default')
    const expected =
      method === 'select' || method === 'confirm'
        ? [{ sessionUpdate: 'tool_call_update', toolCallId: 'pi-ui-dialog', status: 'completed' }]
        : []
    const completed = () => h.conn.updates.filter(n => n.update.sessionUpdate === 'tool_call_update').map(n => n.update)
    assert.deepEqual(completed(), expected)
    h.answer()
    await flush()
    assert.deepEqual(completed(), expected)
    assert.deepEqual(h.proc.extensionUiResponses, [])
  })

  test(`${method} answer before native deadline settles once and clears expiry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = pendingDialog(method)
    t.after(() => h.session.dispose())
    h.emit()
    await flush()
    h.answer()
    await flush()
    const expected =
      method === 'select'
        ? { id: 'dialog', value: 'a' }
        : method === 'confirm'
          ? { id: 'dialog', confirmed: true }
          : { id: 'dialog', value: 'typed' }
    assert.deepEqual(h.proc.extensionUiResponses, [expected])
    assert.equal(h.pendingCount(), 0)
    const delivered = h.conn.updates.length
    t.mock.timers.tick(100)
    await flush()
    assert.equal(h.conn.updates.length, delivered)
    assert.deepEqual(h.proc.extensionUiResponses, [expected])
  })
}

test('native expiry while the permission announcement is blocked never opens a late request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = pendingDialog('confirm')
  t.after(() => h.session.dispose())
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const deliver = h.conn.sessionUpdate.bind(h.conn)
  h.conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'tool_call') await gate
    await deliver(notification)
  }
  h.emit()
  await flush()
  t.mock.timers.tick(25)
  await flush()
  assert.equal(h.pendingCount(), 0)
  assert.equal(h.conn.permissionRequests.length, 0)
  release()
  await flush()
  assert.equal(h.conn.permissionRequests.length, 0)
  assert.deepEqual(
    h.conn.updates.map(n => [n.update.sessionUpdate, 'status' in n.update ? n.update.status : null]),
    [
      ['tool_call', 'pending'],
      ['tool_call_update', 'completed']
    ]
  )
  assert.deepEqual(h.proc.extensionUiResponses, [])
})

for (const timeout of [undefined, null, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '25']) {
  test(`unrepresentable or disabled native timeout ${String(timeout)} leaves the dialog pending`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = pendingDialog('confirm')
    t.after(() => h.session.dispose())
    // Nonfinite native numbers are serialized as null on the JSON wire.
    h.proc.emit(JSON.parse(JSON.stringify({ type: 'extension_ui_request', id: 'dialog', method: 'confirm', timeout })))
    await flush()
    t.mock.timers.tick(100)
    await flush()
    assert.equal(h.pendingCount(), 1)
    assert.equal(h.signals[0]!.aborted, false)
    assert.deepEqual(h.proc.extensionUiResponses, [])
    await h.session.cancel()
    assert.deepEqual(h.proc.extensionUiResponses, [{ id: 'dialog', cancelled: true }])
  })
}

for (const timeout of [-25, 2 ** 31, 0.5, 1.9]) {
  test(`native Node timeout ${timeout} expires after one millisecond`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = pendingDialog('confirm')
    t.after(() => h.session.dispose())
    h.emit(timeout)
    await flush()
    t.mock.timers.tick(1)
    await flush()
    assert.equal(h.pendingCount(), 0)
    assert.equal(h.signals[0]!.aborted, true)
    assert.deepEqual(h.proc.extensionUiResponses, [])
  })
}

for (const settlement of ['cancel', 'dispose', 'duplicate', 'termination', 'shutdown'] as const) {
  for (const expiredFirst of [false, true]) {
    test(`native expiry and ${settlement} settle once (${expiredFirst ? 'expiry first' : 'explicit first'})`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const h = pendingDialog('confirm')
      t.after(() => h.session.dispose())
      h.emit()
      await flush()
      if (expiredFirst) t.mock.timers.tick(25)
      if (settlement === 'cancel') await h.session.cancel()
      else if (settlement === 'dispose') h.session.dispose()
      else if (settlement === 'termination') h.proc.emitTermination()
      else if (settlement === 'shutdown') await h.session.shutdown()
      else h.emit()
      t.mock.timers.tick(25)
      await flush()
      h.answer()
      await flush()
      // A duplicate received after expiry is a new request, which expires independently.
      const count = settlement === 'duplicate' && expiredFirst ? 2 : 1
      assert.equal(h.conn.updates.filter(n => n.update.sessionUpdate === 'tool_call_update').length, count)
      assert.equal(h.pendingCount(), 0)
      assert.deepEqual(h.proc.extensionUiResponses, expiredFirst ? [] : [{ id: 'dialog', cancelled: true }])
    })
  }
}

test('expired permission completes before normal prompt settlement without waiting for a client answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = pendingDialog('confirm')
  t.after(() => h.session.dispose())
  const prompt = h.session.prompt('hello')
  h.proc.emit({ type: 'agent_start' })
  h.emit()
  await flush()
  t.mock.timers.tick(25)
  await flush()
  assert.equal(h.pendingCount(), 0)
  assert.ok(h.conn.updates.some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'completed'))
  h.proc.emit({ type: 'agent_end' })
  h.proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  const delivered = h.conn.updates.length
  h.answer()
  await flush()
  assert.equal(h.conn.updates.length, delivered)
  assert.deepEqual(h.proc.extensionUiResponses, [])
})

test('normal prompt and command completion preserve unrelated idle nontimed dialogs', async () => {
  const h = pendingDialog('confirm')
  try {
    h.emit(0)
    await flush()
    const prompt = h.session.prompt('hello')
    h.proc.emit({ type: 'agent_start' })
    h.proc.emit({ type: 'agent_settled' })
    assert.equal(await prompt, 'end_turn')
    assert.equal(await h.session.runCommand(async () => 'done'), 'done')
    assert.equal(h.pendingCount(), 1)
    assert.equal(h.signals[0]!.aborted, false)
    assert.deepEqual(h.proc.extensionUiResponses, [])
    h.answer()
    await flush()
    assert.deepEqual(h.proc.extensionUiResponses, [{ id: 'dialog', confirmed: true }])
  } finally {
    h.session.dispose()
  }
})

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
    conn.updates
      .filter(notification => notification.update.sessionUpdate === 'tool_call_update')
      .map(notification => notification.update),
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
      if (update.sessionUpdate === 'tool_call') {
        cardId = update.toolCallId
        states.push('pending')
      }
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
      scenario.optionId === 'error'
        ? ['pending', 'waiting', 'completed']
        : ['pending', 'waiting', scenario.status, 'completed']
    )
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'dialog', ...scenario.reply }])
    assert.equal(conn.updates.length, 2)
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
    await tick()
    if (settlement === 'duplicate') proc.emit(event)
    else if (settlement === 'dispose') session.dispose()
    else if (settlement === 'termination') proc.emitTermination()
    else await session.shutdown()
    reply({ outcome: { outcome: 'selected', optionId: 'yes' } })
    await tick()
    assert.equal(requests, 1)
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'dialog', cancelled: true }])
    assert.deepEqual(
      conn.updates
        .filter(notification => notification.update.sessionUpdate === 'tool_call_update')
        .map(notification => notification.update),
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

test('preacceptance permissions announce before requesting and cancel while announcement is blocked', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'ui',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const deliver = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'tool_call') await gate
    await deliver(notification)
  }
  proc.prompt = async () => new Promise(() => {})
  const prompt = session.prompt('/ask')
  proc.emit({ type: 'extension_ui_request', id: 'preflight', method: 'confirm' })
  const cancel = session.cancel()
  await tick()
  assert.equal(conn.permissionRequests.length, 0)
  release()
  await cancel
  assert.equal(await prompt, 'cancelled')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'preflight', cancelled: true }])
})

test('fire-and-forget UI never sends responses, including foreign-run notifications', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({ sessionId: 'ui', cwd: '/tmp', proc: proc as unknown as PiRpcProcess, conn: asAgentConn(conn) })
  for (const method of ['setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'notify'])
    proc.emit({ type: 'extension_ui_request', id: method, method, message: 'notice' })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'foreign', method: 'notify', message: 'foreign' })
  await tick()
  assert.deepEqual(proc.extensionUiResponses, [])
  assert.equal(conn.updates.length, 1)
})
