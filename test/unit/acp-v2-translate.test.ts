import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import {
  isTransparentUpdate,
  toV2AvailableCommands,
  toV2SessionUpdate,
  v1InitializeRequest
} from '../../src/acp/v2/translate.js'

test('v1InitializeRequest: a v2 initialize forwards baseline subagents, compaction, and notices capabilities as opted in', () => {
  // Empty capabilities (and none at all): subagents, compaction, and notices
  // are baseline v2, so the forwarded v1 request opts the engine in on every v2 connection.
  for (const capabilities of [{} as const, undefined]) {
    assert.deepEqual(
      v1InitializeRequest({ protocolVersion: 2, info: { name: 'v2-client', version: '0.0.0' }, capabilities }),
      {
        protocolVersion: 1,
        clientInfo: { name: 'v2-client', version: '0.0.0' },
        clientCapabilities: { session: { compaction: {}, notices: {} }, subagents: {} }
      }
    )
  }

  // The forwarded elicitation survives alongside the baseline opt-ins.
  assert.deepEqual(
    v1InitializeRequest({
      protocolVersion: 2,
      info: { name: 'v2-client', version: '0.0.0' },
      capabilities: { elicitation: { form: {} } }
    }),
    {
      protocolVersion: 1,
      clientInfo: { name: 'v2-client', version: '0.0.0' },
      clientCapabilities: {
        elicitation: { form: {} },
        session: { compaction: {}, notices: {} },
        subagents: {}
      }
    }
  )
})

test('toV2SessionUpdate: subagent_update and session_message pass through unchanged', () => {
  const updates: SessionUpdate[] = [
    {
      sessionUpdate: 'subagent_update',
      sessionId: 'child-1',
      title: 'Research',
      description: 'subagent · researcher',
      capabilities: {},
      state: { state: 'running' },
      _meta: {
        piSubagents: { kind: 'subagent', parentId: null, omitted: { runs: 1, children: 0, byteLimitExceeded: false } }
      }
    },
    {
      sessionUpdate: 'session_message',
      messageId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      senderSessionId: 'parent',
      recipientSessionId: 'child-1',
      content: [{ type: 'text', text: 'Research' }]
    }
  ]
  for (const update of updates) {
    assert.equal(toV2SessionUpdate(update, undefined), update)
  }
})

test('toV2AvailableCommands: tags commands with type: command and inputs with type: text', () => {
  assert.deepEqual(
    toV2AvailableCommands([
      { name: 'compact', description: 'Compact context', input: { hint: 'instructions' } },
      { name: 'clear', description: 'Clear session' }
    ]),
    [
      {
        type: 'command',
        name: 'compact',
        description: 'Compact context',
        input: { type: 'text', hint: 'instructions' }
      },
      { type: 'command', name: 'clear', description: 'Clear session' }
    ]
  )
})

test('toV2SessionUpdate & isTransparentUpdate: compaction_update, compaction_summary_chunk, and notice pass through transparently', () => {
  const updates: SessionUpdate[] = [
    {
      sessionUpdate: 'compaction_update',
      compactionId: 'compaction-1',
      status: 'in_progress'
    },
    {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'compaction-1',
      content: { type: 'text', text: 'Summary of earlier context.' }
    },
    {
      sessionUpdate: 'compaction_update',
      compactionId: 'compaction-1',
      status: 'completed'
    },
    {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'Retrying request',
      description: 'Retrying (attempt 1/3, waiting 2s)...'
    }
  ]

  for (const update of updates) {
    assert.equal(isTransparentUpdate(update), true, `${update.sessionUpdate} must not split streamed messages`)
    assert.equal(toV2SessionUpdate(update, undefined), update)
  }
})
