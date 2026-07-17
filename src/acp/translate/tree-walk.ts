/**
 * Active-branch reconstruction for pi's `get_tree` RPC response.
 *
 * Pi sessions are append-only trees; the conversation a session currently
 * continues from is the root→leafId path. Everything off that path is an
 * abandoned branch and must not be replayed.
 */

export type PiSessionTreeEntry = {
  type: string
  id: string
  parentId: string | null
} & Record<string, unknown>

type PiSessionTreeNode = {
  entry: PiSessionTreeEntry
  children: PiSessionTreeNode[]
}

export class PiSessionTreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiSessionTreeError'
  }
}

function asTreeEntry(value: unknown): PiSessionTreeEntry | null {
  const record = value as { type?: unknown; id?: unknown; parentId?: unknown } | null | undefined
  if (!record || typeof record !== 'object') return null
  if (typeof record.type !== 'string' || typeof record.id !== 'string' || !record.id) return null
  if (record.parentId !== null && typeof record.parentId !== 'string') return null
  return record as PiSessionTreeEntry
}

/**
 * Flatten a `get_tree` response and return the entries on the active branch
 * (root→`leafId`, parent first). Returns `[]` for an empty session
 * (`leafId: null`). Abandoned sibling branches are excluded.
 *
 * Malformed trees fail closed with {@link PiSessionTreeError}: a missing
 * `tree`/`leafId`, an unknown leaf id, duplicate entry ids, or a parent cycle
 * would silently corrupt the replayed history. An entry whose parent is
 * absent from the tree is tolerated as an orphan root: the walk begins there.
 */
export function walkActiveTreeBranch(data: unknown): PiSessionTreeEntry[] {
  const record = data as { tree?: unknown; leafId?: unknown } | null | undefined
  if (!record || typeof record !== 'object' || !Array.isArray(record.tree)) {
    throw new PiSessionTreeError('pi get_tree returned no tree')
  }
  const leafId = record.leafId
  if (leafId !== null && typeof leafId !== 'string') {
    throw new PiSessionTreeError('pi get_tree returned an invalid leafId')
  }
  if (leafId === null) return []

  // Iterative flatten: linear sessions nest one child per entry, so recursion
  // would overflow on long histories.
  const byId = new Map<string, PiSessionTreeEntry>()
  const stack: unknown[] = [...record.tree]
  while (stack.length) {
    const node = stack.pop() as PiSessionTreeNode | null | undefined
    if (!node || typeof node !== 'object') continue

    const entry = asTreeEntry(node.entry)
    if (!entry) continue
    if (byId.has(entry.id)) {
      throw new PiSessionTreeError(`duplicate session entry id: ${entry.id}`)
    }
    byId.set(entry.id, entry)

    if (Array.isArray(node.children)) stack.push(...node.children)
  }

  const leaf = byId.get(leafId)
  if (!leaf) {
    throw new PiSessionTreeError(`session leaf entry not found: ${leafId}`)
  }

  const path: PiSessionTreeEntry[] = []
  const seen = new Set<string>()
  let current: PiSessionTreeEntry | undefined = leaf
  while (current) {
    if (seen.has(current.id)) {
      throw new PiSessionTreeError(`session entry parent cycle at: ${current.id}`)
    }
    seen.add(current.id)
    path.push(current)

    if (current.parentId === null) break
    // A parent missing from the tree is an orphan root: begin the branch there.
    current = byId.get(current.parentId)
  }

  path.reverse()
  return path
}
