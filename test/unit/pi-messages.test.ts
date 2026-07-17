import test from 'node:test'
import assert from 'node:assert/strict'
import {
  translateAssistantContent,
  translateCustomMessageContent,
  translateUserContent
} from '../../src/acp/translate/pi-messages.js'

test('translateCustomMessageContent: normalizes strings and merges consecutive text blocks', () => {
  assert.deepEqual(translateCustomMessageContent('hello'), [{ kind: 'text', text: 'hello' }])
  assert.deepEqual(
    translateCustomMessageContent([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      { type: 'text', text: 'c' }
    ]),
    [
      { kind: 'text', text: 'ab' },
      { kind: 'image', data: 'aW1n', mimeType: 'image/png' },
      { kind: 'text', text: 'c' }
    ]
  )
})

test('translateAssistantContent: keeps text, thinking, and toolCall blocks in source order', () => {
  assert.deepEqual(
    translateAssistantContent([
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'answer' },
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } },
      { type: 'text', text: ' done' },
      { type: 'unknown-block' },
      { type: 'toolCall', id: '', name: 'ignored-missing-id' }
    ]),
    [
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'answer' },
      { kind: 'toolCall', toolCallId: 'call_1', toolName: 'read', rawInput: { path: 'a.txt' } },
      { kind: 'text', text: ' done' }
    ]
  )
  assert.deepEqual(translateAssistantContent('not-an-array'), [])
})

test('translateUserContent: supports plain strings, text blocks, and image blocks', () => {
  assert.deepEqual(translateUserContent('hello'), [{ kind: 'text', text: 'hello' }])
  assert.deepEqual(translateUserContent(''), [])
  assert.deepEqual(
    translateUserContent([
      { type: 'text', text: 'look: ' },
      { type: 'image', data: 'aWFtYXBuZw==', mimeType: 'image/png' },
      { type: 'unknown' }
    ]),
    [
      { kind: 'text', text: 'look: ' },
      { kind: 'image', data: 'aWFtYXBuZw==', mimeType: 'image/png' }
    ]
  )
})
