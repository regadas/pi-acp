import test from 'node:test'
import assert from 'node:assert/strict'
import { promptToPiMessage } from '../../src/acp/translate/prompt.js'

test('promptToPiMessage preserves text, text resources, and valid images', () => {
  const result = promptToPiMessage([
    { type: 'text', text: 'hello' },
    { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'context' } },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    { type: 'resource', resource: { uri: 'file:///b.png', mimeType: 'image/png', blob: 'aGVsbG8=' } }
  ] as any)
  assert.match(result.message, /hello/)
  assert.match(result.message, /context/)
  assert.equal(result.images.length, 2)
})

test('promptToPiMessage rejects malformed and unsupported binary content before returning', () => {
  assert.throws(() => promptToPiMessage([{ type: 'image', mimeType: 'text/plain', data: '***' }] as any), /image/i)
  assert.throws(
    () =>
      promptToPiMessage([
        { type: 'text', text: 'must not be partially sent' },
        { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', blob: 'AA==' } }
      ] as any),
    /Unsupported embedded binary MIME type/
  )
  assert.throws(() => promptToPiMessage([{ type: 'audio', mimeType: 'audio/wav', data: 'AA==' }] as any), /Audio/)
})

test('promptToPiMessage delimits resource links without separating ordinary text chunks', () => {
  assert.equal(
    promptToPiMessage([
      { type: 'resource_link', name: 'a', uri: 'file:///tmp/a.txt' },
      { type: 'text', text: 'Summarize this file.' }
    ]).message,
    '\n[Context] file:///tmp/a.txt\nSummarize this file.'
  )
  assert.equal(
    promptToPiMessage([
      { type: 'text', text: 'sum' },
      { type: 'text', text: 'marize' }
    ]).message,
    'summarize'
  )
})
