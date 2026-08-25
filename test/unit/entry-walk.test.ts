import test from 'node:test'
import assert from 'node:assert/strict'
import { PiSessionEntriesError, walkActiveEntryBranch } from '../../src/acp/translate/entry-walk.js'

function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}) {
  return { type: 'message', id, parentId, ...extra }
}

test('walkActiveEntryBranch: returns the root→leaf path and excludes abandoned sibling branches', () => {
  const entries = [
    entry('a', null),
    entry('b-abandoned', 'a'),
    entry('c-abandoned', 'b-abandoned'),
    entry('b', 'a'),
    entry('c', 'b')
  ]

  const path = walkActiveEntryBranch({ entries, leafId: 'c' })
  assert.deepEqual(
    path.map(value => value.id),
    ['a', 'b', 'c']
  )
})

test('walkActiveEntryBranch: returns [] for an empty session (null leafId)', () => {
  assert.deepEqual(walkActiveEntryBranch({ entries: [], leafId: null }), [])
  assert.deepEqual(walkActiveEntryBranch({ entries: [entry('a', null)], leafId: null }), [])
})

test('walkActiveEntryBranch: fails closed on a missing leaf', () => {
  assert.throws(() => walkActiveEntryBranch({ entries: [entry('a', null)], leafId: 'nope' }), PiSessionEntriesError)
})

test('walkActiveEntryBranch: fails closed on duplicate entry ids', () => {
  const entries = [entry('a', null), entry('dup', 'a'), entry('dup', 'a')]
  assert.throws(() => walkActiveEntryBranch({ entries, leafId: 'dup' }), /duplicate session entry id/)
})

test('walkActiveEntryBranch: fails closed on a parent cycle', () => {
  const entries = [entry('a', 'b'), entry('b', 'a')]
  assert.throws(() => walkActiveEntryBranch({ entries, leafId: 'a' }), /parent cycle/)
})

test('walkActiveEntryBranch: fails closed on a malformed response', () => {
  assert.throws(() => walkActiveEntryBranch(null), PiSessionEntriesError)
  assert.throws(() => walkActiveEntryBranch({}), PiSessionEntriesError)
  assert.throws(() => walkActiveEntryBranch({ entries: [], leafId: 42 }), PiSessionEntriesError)
})

test('walkActiveEntryBranch: malformed entries fail only when they are on the active branch', () => {
  const malformed = { id: 'bad', parentId: null }
  assert.throws(
    () => walkActiveEntryBranch({ entries: [malformed, entry('leaf', 'bad')], leafId: 'leaf' }),
    /malformed session entry in active branch/
  )
  assert.throws(() =>
    walkActiveEntryBranch({ entries: [{ id: '', parentId: null }, entry('leaf', '')], leafId: 'leaf' })
  )

  const path = walkActiveEntryBranch({
    entries: [malformed, entry('root', null), entry('leaf', 'root')],
    leafId: 'leaf'
  })
  assert.deepEqual(
    path.map(value => value.id),
    ['root', 'leaf']
  )
})

test('walkActiveEntryBranch: an orphan whose parent is absent starts the branch at that orphan', () => {
  const entries = [entry('orphan', 'gone-parent'), entry('leaf', 'orphan')]
  const path = walkActiveEntryBranch({ entries, leafId: 'leaf' })
  assert.deepEqual(
    path.map(value => value.id),
    ['orphan', 'leaf']
  )
})

test('walkActiveEntryBranch: preserves entry payloads and deep linear histories', () => {
  const depth = 20_000
  const entries = Array.from({ length: depth }, (_, index) => {
    const number = index + 1
    return entry(`e${number}`, number === 1 ? null : `e${number - 1}`, {
      message: { role: 'user', content: `m${number}` }
    })
  })

  const path = walkActiveEntryBranch({ entries, leafId: `e${depth}` })
  assert.equal(path.length, depth)
  assert.equal(path[0]!.id, 'e1')
  assert.deepEqual(path.at(-1)!.message, { role: 'user', content: `m${depth}` })
})
