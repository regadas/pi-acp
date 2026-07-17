import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultContentBlocks, toolResultToolCallContent } from '../../src/acp/translate/pi-tools.js'

test('toolResultContentBlocks: merges consecutive text blocks', () => {
  assert.deepEqual(
    toolResultContentBlocks({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' }
      ]
    }),
    [{ type: 'text', text: 'hello world' }]
  )
})

test('toolResultContentBlocks: preserves interleaved image/text order', () => {
  assert.deepEqual(
    toolResultContentBlocks({
      content: [
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'text', text: 'between' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' }
      ]
    }),
    [
      { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
      { type: 'text', text: 'between' },
      { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' }
    ]
  )
})

test('toolResultContentBlocks: image-only results never grow a JSON/base64 text block', () => {
  const blocks = toolResultContentBlocks({
    content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]
  })
  assert.deepEqual(blocks, [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }])
})

test('toolResultContentBlocks: details.diff replaces text but keeps images', () => {
  assert.deepEqual(
    toolResultContentBlocks({
      content: [
        { type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
      ],
      details: { diff: '--- a\n+++ b\n' }
    }),
    [
      { type: 'text', text: '--- a\n+++ b\n' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
    ]
  )
})

test('toolResultContentBlocks: falls back to JSON only without recognized content', () => {
  const blocks = toolResultContentBlocks({ a: 1 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.match((blocks[0] as { text: string }).text, /"a": 1/)
})

test('toolResultContentBlocks: extracts bash stdout/stderr from details', () => {
  const blocks = toolResultContentBlocks({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.equal(blocks.length, 1)
  const text = (blocks[0] as { text: string }).text
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultToolCallContent: wraps ordered blocks as ACP tool call content', () => {
  assert.deepEqual(
    toolResultToolCallContent({
      content: [
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'text', text: 'captured' }
      ]
    }),
    [
      { type: 'content', content: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
      { type: 'content', content: { type: 'text', text: 'captured' } }
    ]
  )
})
