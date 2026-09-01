import test from 'node:test'
import assert from 'node:assert/strict'
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
})
