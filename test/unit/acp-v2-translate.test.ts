import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { toV2SessionUpdate, v1InitializeRequest } from '../../src/acp/v2/translate.js'

test('v1InitializeRequest: a v2 initialize forwards the subagents capability as opted in', () => {
  // Empty capabilities (and none at all): subagents are baseline v2, so the
  // forwarded v1 request opts the engine in on every v2 connection.
  for (const capabilities of [{} as const, undefined]) {
    assert.deepEqual(
      v1InitializeRequest({ protocolVersion: 2, info: { name: 'v2-client', version: '0.0.0' }, capabilities }),
      {
        protocolVersion: 1,
        clientInfo: { name: 'v2-client', version: '0.0.0' },
        clientCapabilities: { subagents: {} }
      }
    )
  }

  // The forwarded elicitation survives alongside the baseline opt-in.
  assert.deepEqual(
    v1InitializeRequest({
      protocolVersion: 2,
      info: { name: 'v2-client', version: '0.0.0' },
      capabilities: { elicitation: { form: {} } }
    }),
    {
      protocolVersion: 1,
      clientInfo: { name: 'v2-client', version: '0.0.0' },
      clientCapabilities: { elicitation: { form: {} }, subagents: {} }
    }
  )
})

test('toV2SessionUpdate: subagent_update passes through field for field', () => {
  const update: SessionUpdate = {
    sessionUpdate: 'subagent_update',
    sessionId: 'child-1',
    title: 'Research',
    description: 'subagent · researcher',
    capabilities: {},
    state: { state: 'running' },
    _meta: {
      piSubagents: { kind: 'subagent', parentId: null, omitted: { runs: 1, children: 0, byteLimitExceeded: false } }
    }
  }
  assert.deepEqual(toV2SessionUpdate(update, undefined), update)
})

test('toV2SessionUpdate: session_message passes through field for field', () => {
  const update: SessionUpdate = {
    sessionUpdate: 'session_message',
    messageId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    senderSessionId: 'parent',
    recipientSessionId: 'child-1',
    content: [{ type: 'text', text: 'Research' }]
  }
  assert.deepEqual(toV2SessionUpdate(update, undefined), update)
})
