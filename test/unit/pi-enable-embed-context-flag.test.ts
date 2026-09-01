import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('embedded context is advertised unconditionally', async () => {
  const previous = process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
  process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = 'false'
  try {
    const response = await new PiAcpAgent(asAgentConn(new FakeAgentSideConnection())).initialize({
      protocolVersion: 1,
      clientCapabilities: {}
    } as any)
    assert.equal(response.agentCapabilities?.promptCapabilities?.embeddedContext, true)
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
    else process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = previous
  }
})
