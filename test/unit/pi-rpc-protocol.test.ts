import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePiRecord } from '../../src/pi-rpc/protocol.js'

test('wire decoder accepts current flattened tool stream records', () => {
  const decoded = decodePiRecord({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 0,
      id: 'call-1',
      toolName: 'read',
      argumentsDelta: '{"path":"README.md"}'
    }
  })
  assert.equal(decoded?.type, 'message_update')
  assert.equal((decoded as any).assistantMessageEvent.argumentsDelta, '{"path":"README.md"}')
})

test('wire decoder ignores malformed records and marks future events explicitly', () => {
  assert.equal(decodePiRecord(null), null)
  assert.equal(decodePiRecord({ type: 'response', success: true }), null)
  assert.deepEqual(decodePiRecord({ type: 'future_event', payload: 1 }), {
    type: 'ignored',
    originalType: 'future_event'
  })
})

test('wire decoder preserves validated extension diagnostics', () => {
  const event = {
    type: 'extension_error',
    extensionPath: 'command:deploy',
    event: 'command',
    error: 'deployment failed'
  }
  assert.deepEqual(decodePiRecord(event), event)
  for (const field of ['extensionPath', 'event', 'error']) {
    for (const value of [undefined, null, 17, {}, []]) {
      assert.equal(decodePiRecord({ ...event, [field]: value }), null)
    }
  }
})
