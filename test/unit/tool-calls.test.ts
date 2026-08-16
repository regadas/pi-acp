import test from 'node:test'
import assert from 'node:assert/strict'
import { getEditOldTexts } from '../../src/acp/translate/tool-calls.js'

// `oldText` candidates anchor a best-effort line hint for an edit tool call:
// complete `{ oldText, newText }` pairs are the strongest signal, but an entry
// that only carries `oldText` still locates the text being replaced.

test('getEditOldTexts: complete pairs come first, then any remaining candidate', () => {
  assert.deepEqual(
    getEditOldTexts({
      oldText: 'legacy',
      newText: 'legacy-new',
      edits: [
        { oldText: 'first', newText: 'first-new' },
        { oldText: 'second', newText: 'second-new' }
      ]
    }),
    ['legacy', 'first', 'second']
  )
})

test('getEditOldTexts: an entry with a malformed newText still contributes a hint', () => {
  assert.deepEqual(
    getEditOldTexts({
      edits: [{ oldText: 'complete', newText: 'done' }, { oldText: 'missing-new-text' }, { oldText: 'bad', newText: 7 }]
    }),
    ['complete', 'missing-new-text', 'bad']
  )

  // A legacy top-level `oldText` without its `newText` is not a complete pair,
  // so it is ordered after the pairs but still offered.
  assert.deepEqual(getEditOldTexts({ oldText: 'legacy', edits: [{ oldText: 'pair', newText: 'new' }] }), [
    'pair',
    'legacy'
  ])
})

test('getEditOldTexts: stringified edits are parsed and duplicates collapse', () => {
  assert.deepEqual(
    getEditOldTexts({
      oldText: 'shared',
      newText: 'shared-new',
      edits: JSON.stringify([{ oldText: 'shared', newText: 'shared-new' }, { oldText: 'extra' }])
    }),
    ['shared', 'extra']
  )
})

test('getEditOldTexts: malformed input yields no candidates', () => {
  assert.deepEqual(getEditOldTexts({ edits: '{not json' }), [])
  assert.deepEqual(getEditOldTexts({ edits: { oldText: 'not-an-array' } }), [])
  assert.deepEqual(getEditOldTexts({ oldText: 42, edits: [null, 'nope', { oldText: 5 }] }), [])
  assert.deepEqual(getEditOldTexts(null), [])
  assert.deepEqual(getEditOldTexts(undefined), [])
  assert.deepEqual(getEditOldTexts('edit'), [])
})
