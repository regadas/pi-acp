import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getEditOldTexts,
  resolveValidToolPath,
  toToolCallLocations,
  validLocationLine
} from '../../src/acp/translate/tool-calls.js'

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

test('toToolCallLocations & resolveValidToolPath: drops malformed/NUL/non-file/broken-symlink hints and bad lines safely', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-tool-loc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const filePath = join(root, 'file.txt')
  const dirPath = join(root, 'subdir')
  writeFileSync(filePath, 'hello\n', 'utf8')
  mkdirSync(dirPath)

  // Valid file + valid 1-based line.
  assert.deepEqual(toToolCallLocations('read', { path: 'file.txt' }, root, 3), [{ path: filePath, line: 3 }])

  // Non-integer, zero, negative, NaN, Infinity line numbers are dropped without dropping the valid path.
  for (const badLine of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(validLocationLine(badLine), undefined)
    assert.deepEqual(toToolCallLocations('read', { path: 'file.txt' }, root, badLine), [{ path: filePath }])
  }

  // NUL, control chars, blank paths, directories are dropped cleanly without throwing.
  assert.equal(resolveValidToolPath('foo\x00bar.txt', root), undefined)
  assert.equal(resolveValidToolPath('foo\nbar.txt', root), undefined)
  assert.equal(resolveValidToolPath('   ', root), undefined)
  assert.equal(toToolCallLocations('read', { path: 'foo\x00bar.txt' }, root), undefined)
  assert.equal(toToolCallLocations('write', { path: 'foo\x00bar.txt' }, root), undefined)
  assert.equal(toToolCallLocations('read', { path: 'subdir' }, root), undefined)

  // Missing target preserved for write, omitted for read.
  const newTarget = join(root, 'new.txt')
  assert.deepEqual(toToolCallLocations('write', { path: 'new.txt' }, root), [{ path: newTarget }])
  assert.equal(toToolCallLocations('read', { path: 'new.txt' }, root), undefined)

  // Broken symlink dropped cleanly without throwing; valid symlink preserved.
  if (process.platform !== 'win32') {
    const broken = join(root, 'broken-link')
    symlinkSync(join(root, 'does-not-exist'), broken)
    assert.equal(toToolCallLocations('read', { path: broken }, root), undefined)
    assert.equal(toToolCallLocations('write', { path: broken }, root), undefined)

    const validLink = join(root, 'valid-link')
    symlinkSync(filePath, validLink)
    assert.deepEqual(toToolCallLocations('read', { path: validLink }, root, 1), [{ path: validLink, line: 1 }])
  }
})
