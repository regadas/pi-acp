import test from 'node:test'
import assert from 'node:assert/strict'

import { bashOrderedContent } from '../../src/acp/translate/bash.js'

function textContent(result: unknown): string {
  const content = bashOrderedContent(result)
  assert.equal(content.length, 1)
  assert.equal(content[0]?.type, 'content')
  const block = content[0] as { type: 'content'; content: { type: string; text?: string } }
  assert.equal(block.content.type, 'text')
  assert.equal(typeof block.content.text, 'string')
  return block.content.text!
}

test('bashOrderedContent: preserves whitespace-only content text', () => {
  assert.equal(textContent({ content: [{ type: 'text', text: '   ' }] }), '```console\n   \n```')
})

test('bashOrderedContent: preserves trailing spaces and newlines', () => {
  assert.equal(textContent({ content: [{ type: 'text', text: 'value  \n\n' }] }), '```console\nvalue  \n\n```')
})

test('bashOrderedContent: uses a fence longer than embedded backtick runs', () => {
  const text = 'before\n``````\nafter'
  assert.equal(textContent({ content: [{ type: 'text', text }] }), '```````console\nbefore\n``````\nafter\n```````')
})

test('bashOrderedContent: preserves whitespace-only details fallback', () => {
  assert.equal(textContent({ content: [], details: { stdout: ' \n' } }), '```console\n \n```')
})
