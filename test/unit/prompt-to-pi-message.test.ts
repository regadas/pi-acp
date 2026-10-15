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

test('promptToPiMessage separates an embedded text resource from the following text block', () => {
  assert.equal(
    promptToPiMessage([
      { type: 'resource', resource: { uri: 'file:///snippet.ts', mimeType: 'text/plain', text: 'const a = 1' } },
      { type: 'text', text: 'Explain' }
    ]).message,
    '\n[Embedded Context] file:///snippet.ts (text/plain)\nconst a = 1\nExplain'
  )
})

test('promptToPiMessage accepts structurally valid multi-megabyte base64 images without a stack overflow', () => {
  const data = 'A'.repeat(16_000_000)
  const result = promptToPiMessage([{ type: 'image', mimeType: 'image/png', data }] as any)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0]?.data, data)
})

test('promptToPiMessage accepts every canonical base64 padding form', () => {
  for (const data of ['AAAA', 'AAA=', 'AA==']) {
    const result = promptToPiMessage([{ type: 'image', mimeType: 'image/png', data }] as any)
    assert.equal(result.images[0]?.data, data)
  }
})

test('promptToPiMessage rejects malformed base64 alphabet and padding', () => {
  for (const data of ['A', '=', 'AA', 'AA=', 'A===', '====', 'AA=A', 'AAAA=', 'AAAA!', 'A'.repeat(5), 'aGVsbG8']) {
    assert.throws(
      () => promptToPiMessage([{ type: 'image', mimeType: 'image/png', data }] as any),
      /malformed base64/,
      `data=${data}`
    )
  }
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
