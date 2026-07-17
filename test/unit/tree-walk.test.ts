import test from 'node:test'
import assert from 'node:assert/strict'
import { PiSessionTreeError, walkActiveTreeBranch } from '../../src/acp/translate/tree-walk.js'

function node(id: string, parentId: string | null, children: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { entry: { type: 'message', id, parentId, ...extra }, children }
}

test('walkActiveTreeBranch: returns the root→leaf path and excludes abandoned sibling branches', () => {
  const tree = [
    node('a', null, [node('b-abandoned', 'a', [node('c-abandoned', 'b-abandoned')]), node('b', 'a', [node('c', 'b')])])
  ]

  const path = walkActiveTreeBranch({ tree, leafId: 'c' })
  assert.deepEqual(
    path.map(entry => entry.id),
    ['a', 'b', 'c']
  )
})

test('walkActiveTreeBranch: returns [] for an empty session (null leafId)', () => {
  assert.deepEqual(walkActiveTreeBranch({ tree: [], leafId: null }), [])
  assert.deepEqual(walkActiveTreeBranch({ tree: [node('a', null)], leafId: null }), [])
})

test('walkActiveTreeBranch: fails closed on a missing leaf', () => {
  assert.throws(() => walkActiveTreeBranch({ tree: [node('a', null)], leafId: 'nope' }), PiSessionTreeError)
})

test('walkActiveTreeBranch: fails closed on duplicate entry ids', () => {
  const tree = [node('a', null, [node('dup', 'a'), node('dup', 'a')])]
  assert.throws(() => walkActiveTreeBranch({ tree, leafId: 'dup' }), /duplicate session entry id/)
})

test('walkActiveTreeBranch: fails closed on a parent cycle', () => {
  // parentId links forming a cycle: a → b → a (tree nesting can't express a
  // real cycle, so simulate corrupted parent pointers on sibling roots).
  const tree = [node('a', 'b'), node('b', 'a')]
  assert.throws(() => walkActiveTreeBranch({ tree, leafId: 'a' }), /parent cycle/)
})

test('walkActiveTreeBranch: fails closed on a malformed response', () => {
  assert.throws(() => walkActiveTreeBranch(null), PiSessionTreeError)
  assert.throws(() => walkActiveTreeBranch({}), PiSessionTreeError)
  assert.throws(() => walkActiveTreeBranch({ tree: [], leafId: 42 }), PiSessionTreeError)
})

test('walkActiveTreeBranch: an orphan whose parent is absent starts the branch at that orphan', () => {
  const tree = [node('orphan', 'gone-parent', [node('leaf', 'orphan')])]
  const path = walkActiveTreeBranch({ tree, leafId: 'leaf' })
  assert.deepEqual(
    path.map(entry => entry.id),
    ['orphan', 'leaf']
  )
})

test('walkActiveTreeBranch: preserves entry payloads and deep linear chains', () => {
  // Deep chain to guard against recursive flattening (real sessions can have
  // thousands of entries on one branch).
  const depth = 20_000
  let child: any = null
  for (let i = depth; i >= 1; i--) {
    const n = node(`e${i}`, i === 1 ? null : `e${i - 1}`, [], { message: { role: 'user', content: `m${i}` } })
    if (child) n.children.push(child)
    child = n
  }

  const path = walkActiveTreeBranch({ tree: [child], leafId: `e${depth}` })
  assert.equal(path.length, depth)
  assert.equal(path[0]!.id, 'e1')
  assert.deepEqual(path.at(-1)!.message, { role: 'user', content: `m${depth}` })
})
