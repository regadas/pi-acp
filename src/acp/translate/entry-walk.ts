/**
 * Active-branch reconstruction for pi's flat `get_entries` RPC response.
 *
 * Pi sessions are append-only trees; the conversation a session currently
 * continues from is the root→leafId path. Everything off that path is an
 * abandoned branch and must not be replayed.
 */

export type PiSessionEntry = {
  type: string
  id: string
  parentId: string | null
} & Record<string, unknown>

export class PiSessionEntriesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiSessionEntriesError'
  }
}

function asSessionEntry(value: unknown): PiSessionEntry | null {
  const record = value as { type?: unknown; id?: unknown; parentId?: unknown } | null | undefined
  if (!record || typeof record !== 'object') return null
  if (typeof record.type !== 'string' || typeof record.id !== 'string' || !record.id) return null
  if (record.parentId !== null && (typeof record.parentId !== 'string' || !record.parentId)) return null
  return record as PiSessionEntry
}

/**
 * Return the entries on the active branch (root→`leafId`, parent first).
 * Returns `[]` for an empty session (`leafId: null`). Abandoned sibling
 * branches are excluded.
 *
 * Malformed snapshots fail closed with {@link PiSessionEntriesError}: missing
 * `entries`/`leafId`, an unknown leaf id, duplicate entry ids, or a parent
 * cycle would silently corrupt the replayed history. An entry whose parent is
 * absent from the snapshot is tolerated as an orphan root.
 */
export function walkActiveEntryBranch(data: unknown): PiSessionEntry[] {
  const record = data as { entries?: unknown; leafId?: unknown } | null | undefined
  if (!record || typeof record !== 'object' || !Array.isArray(record.entries)) {
    throw new PiSessionEntriesError('pi get_entries returned no entries')
  }
  const leafId = record.leafId
  if (leafId !== null && typeof leafId !== 'string') {
    throw new PiSessionEntriesError('pi get_entries returned an invalid leafId')
  }
  if (leafId === null) return []

  const byId = new Map<string, PiSessionEntry>()
  const malformedIds = new Set<string>()
  for (const value of record.entries) {
    const entry = asSessionEntry(value)
    if (!entry) {
      const id = (value as { id?: unknown } | null | undefined)?.id
      if (typeof id === 'string' && id) {
        if (byId.has(id) || malformedIds.has(id)) {
          throw new PiSessionEntriesError(`duplicate session entry id: ${id}`)
        }
        malformedIds.add(id)
      }
      continue
    }
    if (byId.has(entry.id) || malformedIds.has(entry.id)) {
      throw new PiSessionEntriesError(`duplicate session entry id: ${entry.id}`)
    }
    byId.set(entry.id, entry)
  }

  const leaf = byId.get(leafId)
  if (!leaf) {
    throw new PiSessionEntriesError(`session leaf entry not found: ${leafId}`)
  }

  const path: PiSessionEntry[] = []
  const seen = new Set<string>()
  let current: PiSessionEntry | undefined = leaf
  while (current) {
    if (seen.has(current.id)) {
      throw new PiSessionEntriesError(`session entry parent cycle at: ${current.id}`)
    }
    seen.add(current.id)
    path.push(current)

    if (current.parentId === null) break
    if (malformedIds.has(current.parentId)) {
      throw new PiSessionEntriesError(`malformed session entry in active branch: ${current.parentId}`)
    }
    current = byId.get(current.parentId)
  }

  path.reverse()
  return path
}
