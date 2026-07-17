import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const isInvalidParams = (e: any) => {
  assert.equal(e?.code, -32602)
  assert.match(String(e?.message), /not advertised/i)
  return true
}

test('authenticate: accepts only the method IDs advertised at initialize', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const init = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } }
  } as any)
  assert.deepEqual(
    init.authMethods?.map(m => m.id),
    [PI_SETUP_METHOD_ID]
  )

  await assert.doesNotReject(() => agent.authenticate({ methodId: PI_SETUP_METHOD_ID } as any))
  await assert.rejects(() => agent.authenticate({ methodId: 'password' } as any), isInvalidParams)
  await assert.rejects(() => agent.authenticate({ methodId: '' } as any), isInvalidParams)
})

test('authenticate: rejects every method when initialize advertised none', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
  assert.deepEqual(init.authMethods, [])

  await assert.rejects(() => agent.authenticate({ methodId: PI_SETUP_METHOD_ID } as any), isInvalidParams)
})

test('authenticate: rejects before initialize (nothing has been advertised yet)', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await assert.rejects(() => agent.authenticate({ methodId: PI_SETUP_METHOD_ID } as any), isInvalidParams)
})
