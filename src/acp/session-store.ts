import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
  /**
   * Additional workspace roots for the session, in request order. Optional so
   * old records (which have none) stay valid; consumers treat missing as [].
   */
  additionalDirectories?: readonly string[]
  /**
   * Explicit title set via `session/set_title` or `/name`. Authoritative ACP
   * overlay preserved across metadata/cwd/root refreshes and cleared on delete.
   */
  explicitTitle?: string
}

/**
 * A store file exists but does not contain valid state. Corruption is never
 * silently treated as "no data": overwriting it with an empty map would
 * destroy every recorded session mapping on a transient parse problem.
 */
export class SessionStoreCorruptError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    super(
      `pi-acp session store record is corrupt: ${path} (${detail}). ` +
        'Repair or delete the file manually; it will not be overwritten automatically.'
    )
    this.name = 'SessionStoreCorruptError'
    this.path = path
  }
}

/** Attempted to write an explicit title for a session that has been tombstoned/deleted. */
export class SessionTombstonedError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`Session has been deleted: ${sessionId}`)
    this.name = 'SessionTombstonedError'
    this.sessionId = sessionId
  }
}

type LegacySessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

/** One per-session record: either live state or a deletion tombstone. */
type SessionRecordFile =
  { version: 1; deleted?: false; session: StoredSession } | { version: 1; deleted: true; sessionId: string }

/** Independent atomic sidecar for an explicit ACP title, isolated from metadata refreshes. */
type SessionTitleSidecarFile = {
  version: 1
  sessionId: string
  explicitTitle: string
  revision?: string
}

function isStoredSession(value: unknown): value is StoredSession {
  const record = value as StoredSession | null | undefined
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.sessionId === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.sessionFile === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.additionalDirectories === undefined ||
      (Array.isArray(record.additionalDirectories) &&
        record.additionalDirectories.every(root => typeof root === 'string')))
  )
}

function parseRecord(path: string, raw: string, expectedSessionId?: string): SessionRecordFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new SessionStoreCorruptError(path, `invalid JSON: ${String((e as Error)?.message ?? e)}`)
  }

  const record = parsed as { version?: unknown; deleted?: unknown; session?: unknown; sessionId?: unknown } | null
  if (!record || typeof record !== 'object' || record.version !== 1) {
    throw new SessionStoreCorruptError(path, 'unknown record shape or version')
  }
  if (record.deleted === true) {
    if (typeof record.sessionId !== 'string') throw new SessionStoreCorruptError(path, 'tombstone without sessionId')
    if (expectedSessionId !== undefined && record.sessionId !== expectedSessionId) {
      throw new SessionStoreCorruptError(
        path,
        `tombstone sessionId ${record.sessionId} does not match ${expectedSessionId}`
      )
    }
    return { version: 1, deleted: true, sessionId: record.sessionId }
  }
  if (record.deleted !== undefined && record.deleted !== false) {
    throw new SessionStoreCorruptError(path, 'invalid deleted marker')
  }
  if (!isStoredSession(record.session)) {
    throw new SessionStoreCorruptError(path, 'live record without a valid session')
  }
  if (expectedSessionId !== undefined && record.session.sessionId !== expectedSessionId) {
    throw new SessionStoreCorruptError(
      path,
      `live record sessionId ${record.session.sessionId} does not match ${expectedSessionId}`
    )
  }
  return { version: 1, session: record.session }
}

function parseTitleSidecar(path: string, raw: string, expectedSessionId?: string): SessionTitleSidecarFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new SessionStoreCorruptError(path, `invalid JSON: ${String((e as Error)?.message ?? e)}`)
  }
  const record = parsed as {
    version?: unknown
    sessionId?: unknown
    explicitTitle?: unknown
    revision?: unknown
  } | null
  if (
    !record ||
    typeof record !== 'object' ||
    record.version !== 1 ||
    typeof record.sessionId !== 'string' ||
    typeof record.explicitTitle !== 'string' ||
    (record.revision !== undefined && typeof record.revision !== 'string')
  ) {
    throw new SessionStoreCorruptError(path, 'unknown title sidecar shape or version')
  }
  if (expectedSessionId !== undefined && record.sessionId !== expectedSessionId) {
    throw new SessionStoreCorruptError(
      path,
      `title sidecar sessionId ${record.sessionId} does not match ${expectedSessionId}`
    )
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    explicitTitle: record.explicitTitle,
    ...(record.revision !== undefined ? { revision: record.revision } : {})
  }
}

function parseLegacyMap(path: string, raw: string): LegacySessionMapFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new SessionStoreCorruptError(path, `invalid JSON: ${String((e as Error)?.message ?? e)}`)
  }
  const map = parsed as LegacySessionMapFile | null
  if (
    !map ||
    typeof map !== 'object' ||
    map.version !== 1 ||
    typeof map.sessions !== 'object' ||
    !map.sessions ||
    Array.isArray(map.sessions)
  ) {
    throw new SessionStoreCorruptError(path, 'unknown map shape or version')
  }

  return map
}

/** Reads that must distinguish "absent" (null) from corruption (throw). */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
}

let tempCounter = 0

/** Bound concurrent record reads so a large state directory cannot exhaust fds. */
const RECORD_READ_CONCURRENCY = 32

/**
 * Order-preserving bounded-concurrency map: the results keep the input order
 * while only `limit` operations run at once.
 */
export async function boundedAll<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  for (let offset = 0; offset < items.length; offset += limit) {
    await Promise.all(
      items.slice(offset, offset + limit).map(async (item, index) => {
        results[offset + index] = await run(item)
      })
    )
  }
  return results
}

type SyncBufferWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number

/** Write a buffer completely even when the underlying write makes partial progress. */
export function writeBufferFully(fd: number, buffer: Buffer, writer: SyncBufferWriter = writeSync): void {
  let offset = 0
  while (offset < buffer.length) {
    const remaining = buffer.length - offset
    const written = writer(fd, buffer, offset, remaining)
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error(`session store write made invalid progress: ${String(written)} of ${remaining} bytes`)
    }
    offset += written
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Opening/fsyncing directories is unsupported on some platforms.
  } finally {
    try {
      if (fd !== null) closeSync(fd)
    } catch {
      // ignore
    }
  }
}

/**
 * Atomic single-file write: unique same-directory temp file, fsync, rename.
 * Readers therefore always observe either the previous or the new complete
 * record; concurrent writers for the same path serialize on rename order
 * (last writer wins with a valid record either way).
 */
function writeFileAtomic(path: string, data: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${++tempCounter}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'w', 0o600)
    writeBufferFully(fd, Buffer.from(data, 'utf8'))
    try {
      fsyncSync(fd)
    } catch {
      // Best-effort durability; atomicity comes from the rename below.
    }
    closeSync(fd)
    fd = null
    renameSync(tempPath, path)
    fsyncDirectoryBestEffort(directory)
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd)
    } catch {
      // ignore
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore (already renamed or never created)
    }
    throw error
  }
}

/**
 * Durable sessionId -> {cwd, sessionFile} mapping.
 *
 * Layout: one atomic state file per session under `<legacy-map>.d/`, named by
 * a path-safe encoding of the sessionId. Each file is either a live record or
 * a deletion tombstone. Because no two sessions ever share a read-modify-write
 * file and each write replaces one whole record atomically, concurrent pi-acp
 * processes cannot lose each other's updates (the legacy shared JSON map
 * could). The legacy `session-map.json` is retained read-only as a migration
 * fallback; tombstones keep deleted legacy entries from resurrecting.
 */
export class SessionStore {
  private readonly legacyMapPath: string
  private readonly stateDir: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.legacyMapPath = path
    this.stateDir = `${path}.d`
  }

  private recordBaseName(sessionId: string): string {
    const encoded = Buffer.from(sessionId, 'utf-8').toString('base64url')
    // Path-safe and reversible for realistic ids (UUIDs); hash unusually long
    // ids so the file name stays within filesystem limits.
    return encoded.length <= 180 ? encoded : `sha256-${createHash('sha256').update(sessionId).digest('hex')}`
  }

  private recordPath(sessionId: string): string {
    return join(this.stateDir, `${this.recordBaseName(sessionId)}.json`)
  }

  private titleSidecarPath(sessionId: string): string {
    return join(this.stateDir, `${this.recordBaseName(sessionId)}.title`)
  }

  private readTitleSidecarRecord(sessionId: string): SessionTitleSidecarFile | null {
    const path = this.titleSidecarPath(sessionId)
    const raw = readFileOrNull(path)
    return raw === null ? null : parseTitleSidecar(path, raw, sessionId)
  }

  private readTitleSidecar(sessionId: string): string | null {
    return this.readTitleSidecarRecord(sessionId)?.explicitTitle ?? null
  }

  /** Whether the direct record for this session is currently a deletion tombstone. */
  isTombstoned(sessionId: string): boolean {
    return this.readDirect(sessionId)?.deleted === true
  }

  /**
   * Write or clear the independent per-session explicit-title sidecar atomically.
   * Refuses to write when the direct session record is tombstoned.
   */
  setExplicitTitle(sessionId: string, explicitTitle: string | null): { committed: boolean; revision?: string } {
    const direct = this.readDirect(sessionId)
    const path = this.titleSidecarPath(sessionId)
    // Preserve corruption visibility before replacing or removing.
    this.readTitleSidecarRecord(sessionId)
    if (explicitTitle === null) {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return { committed: true }
    }
    if (direct?.deleted === true) {
      return { committed: false }
    }
    const revision = randomUUID()
    const sidecar: SessionTitleSidecarFile = { version: 1, sessionId, explicitTitle, revision }
    writeFileAtomic(path, JSON.stringify(sidecar, null, 2) + '\n')
    return { committed: true, revision }
  }

  /**
   * Roll back an explicit title only if the session has not been tombstoned and
   * the on-disk sidecar still carries `expectedRevision`. Prevents clobbering a
   * concurrent newer rename or recreating a sidecar behind a tombstone.
   */
  rollbackExplicitTitle(sessionId: string, expectedRevision: string, previousTitle: string | null): boolean {
    const direct = this.readDirect(sessionId)
    if (direct?.deleted === true) return false
    const current = this.readTitleSidecarRecord(sessionId)
    if (!current || current.revision !== expectedRevision) return false
    if (previousTitle === null) {
      try {
        unlinkSync(this.titleSidecarPath(sessionId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return true
    }
    const restored: SessionTitleSidecarFile = {
      version: 1,
      sessionId,
      explicitTitle: previousTitle,
      revision: randomUUID()
    }
    writeFileAtomic(this.titleSidecarPath(sessionId), JSON.stringify(restored, null, 2) + '\n')
    return true
  }

  private readLegacy(sessionId: string): StoredSession | null {
    const raw = readFileOrNull(this.legacyMapPath)
    if (raw === null) return null

    const map = parseLegacyMap(this.legacyMapPath, raw)

    const entry = map.sessions[sessionId]
    if (entry === undefined) return null
    if (!isStoredSession(entry) || entry.sessionId !== sessionId) {
      throw new SessionStoreCorruptError(this.legacyMapPath, `invalid legacy entry for ${sessionId}`)
    }
    return entry
  }

  private readDirect(sessionId: string): SessionRecordFile | null {
    const path = this.recordPath(sessionId)
    const raw = readFileOrNull(path)
    return raw === null ? null : parseRecord(path, raw, sessionId)
  }

  get(sessionId: string): StoredSession | null {
    const record = this.readDirect(sessionId)
    if (record) {
      if (record.deleted) return null
      const sidecarTitle = this.readTitleSidecar(sessionId)
      return sidecarTitle !== null ? { ...record.session, explicitTitle: sidecarTitle } : record.session
    }
    const legacy = this.readLegacy(sessionId)
    if (!legacy) return null
    const sidecarTitle = this.readTitleSidecar(sessionId)
    return sidecarTitle !== null ? { ...legacy, explicitTitle: sidecarTitle } : legacy
  }

  /** Enumerate live records, including legacy entries not hidden by tombstones. */
  async list(): Promise<StoredSession[]> {
    const byId = new Map<string, StoredSession>()
    let legacyRaw: string | null = null
    try {
      legacyRaw = await readFile(this.legacyMapPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (legacyRaw !== null) {
      const legacy = parseLegacyMap(this.legacyMapPath, legacyRaw)
      for (const [id, session] of Object.entries(legacy.sessions)) {
        if (!isStoredSession(session) || session.sessionId !== id) {
          throw new SessionStoreCorruptError(this.legacyMapPath, `invalid legacy entry for ${id}`)
        }
        byId.set(id, session)
      }
    }

    let allNames: string[] = []
    try {
      allNames = await readdir(this.stateDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const recordNames = allNames.filter(name => name.endsWith('.json'))
    const titleNames = allNames.filter(name => name.endsWith('.title'))

    const paths = recordNames.map(name => join(this.stateDir, name))
    // Parsing stays sequential so corruption surfaces exactly like get()'s.
    const contents = await boundedAll(paths, RECORD_READ_CONCURRENCY, path => readFile(path, 'utf8'))
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!
      const record = parseRecord(path, contents[index]!)
      const id = record.deleted ? record.sessionId : record.session.sessionId
      if (path !== this.recordPath(id)) {
        throw new SessionStoreCorruptError(path, `record filename does not match sessionId ${id}`)
      }
      if (record.deleted) byId.delete(id)
      else byId.set(id, record.session)
    }

    // Overlay independent explicit-title sidecars onto live (non-tombstoned) sessions.
    const titlePaths = titleNames.map(name => join(this.stateDir, name))
    const titleContents = await boundedAll(titlePaths, RECORD_READ_CONCURRENCY, async path => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        // A concurrent delete or rollback may unlink a sidecar between readdir and readFile.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    })
    for (let index = 0; index < titlePaths.length; index++) {
      const raw = titleContents[index]
      if (raw === null || raw === undefined) continue
      const path = titlePaths[index]!
      const sidecar = parseTitleSidecar(path, raw)
      if (path !== this.titleSidecarPath(sidecar.sessionId)) {
        throw new SessionStoreCorruptError(path, `title sidecar filename does not match sessionId ${sidecar.sessionId}`)
      }
      const existing = byId.get(sidecar.sessionId)
      if (existing) byId.set(sidecar.sessionId, { ...existing, explicitTitle: sidecar.explicitTitle })
    }
    return [...byId.values()]
  }

  upsert(entry: {
    sessionId: string
    cwd: string
    sessionFile: string
    additionalDirectories?: readonly string[]
    explicitTitle?: string | null
    preserveUpdatedAt?: boolean
  }): string | undefined {
    // Refuse to replace malformed state. This validation is intentionally per
    // record and does not introduce a shared read-modify-write file.
    const current = this.readDirect(entry.sessionId)
    const previousSidecar = entry.explicitTitle !== undefined ? this.readTitleSidecarRecord(entry.sessionId) : undefined
    // A concurrent delete tombstones the id after unlinking its file; a stale
    // discovery upsert must not resurrect that mapping. An explicit title write
    // against a tombstoned session fails closed instead of silently succeeding.
    if (current?.deleted === true) {
      if (entry.explicitTitle !== undefined) throw new SessionTombstonedError(entry.sessionId)
      if (!existsSync(entry.sessionFile)) return undefined
    }

    // When updating only the explicit title on an already-mapped live session
    // with matching cwd/sessionFile, write ONLY `<id>.title` and leave
    // `<id>.json` untouched so a concurrent deletion tombstone is never overwritten.
    if (
      entry.explicitTitle !== undefined &&
      entry.additionalDirectories === undefined &&
      current !== null &&
      !current.deleted &&
      current.session.cwd === entry.cwd &&
      current.session.sessionFile === entry.sessionFile
    ) {
      const outcome = this.setExplicitTitle(entry.sessionId, entry.explicitTitle)
      if (!outcome.committed) throw new SessionTombstonedError(entry.sessionId)
      return outcome.revision
    }

    let legacyExisting: StoredSession | null = null
    if (current === null) {
      try {
        legacyExisting = this.readLegacy(entry.sessionId)
      } catch (error) {
        if (!(error instanceof SessionStoreCorruptError)) throw error
        // Corrupt legacy map must not block writing a fresh per-session direct record.
      }
    }
    const existing = current === null ? legacyExisting : 'session' in current ? current.session : null
    // An omitted root list preserves the recorded value (including from legacy
    // fallback): ordinary metadata refreshes (cwd repairs, discovery
    // re-mappings) must not clear workspace roots. Explicit titles live solely
    // in `<id>.title` so cross-process metadata refreshes never touch them.
    const additionalDirectories = entry.additionalDirectories ?? existing?.additionalDirectories
    const updatedAt = entry.preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : new Date().toISOString()
    const record: SessionRecordFile = {
      version: 1,
      session: {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        sessionFile: entry.sessionFile,
        updatedAt,
        ...(additionalDirectories ? { additionalDirectories } : {})
      }
    }

    // shortcut: cross-process check-then-write when creating `<id>.json` for an
    // unmapped session (or rolling back a sidecar) can race a concurrent delete
    // from another process; upgrade to a lockfile if multi-writer adapters are added.
    let sidecarRevision: string | undefined
    if (entry.explicitTitle !== undefined) {
      const outcome = this.setExplicitTitle(entry.sessionId, entry.explicitTitle)
      if (!outcome.committed) throw new SessionTombstonedError(entry.sessionId)
      sidecarRevision = outcome.revision
    }

    try {
      writeFileAtomic(this.recordPath(entry.sessionId), JSON.stringify(record, null, 2) + '\n')
    } catch (error) {
      // If writing the main record fails after creating/updating the sidecar,
      // restore the prior sidecar state best-effort so no orphan title leaks.
      if (entry.explicitTitle !== undefined) {
        try {
          if (sidecarRevision) {
            this.rollbackExplicitTitle(entry.sessionId, sidecarRevision, previousSidecar?.explicitTitle ?? null)
          } else if (previousSidecar) {
            writeFileAtomic(this.titleSidecarPath(entry.sessionId), JSON.stringify(previousSidecar, null, 2) + '\n')
          }
        } catch {
          // Best-effort cleanup; original write error takes precedence.
        }
      }
      throw error
    }
    return sidecarRevision
  }

  delete(sessionId: string): void {
    // Validate both the direct record and any explicit-title sidecar UP FRONT
    // before mutating either file so corruption stays visible cleanly.
    this.readDirect(sessionId)
    this.readTitleSidecarRecord(sessionId)
    // A tombstone (not unlink) is required: unlinking the direct record would
    // let a stale legacy-map entry resurrect the session on the next get().
    const record: SessionRecordFile = { version: 1, deleted: true, sessionId }
    writeFileAtomic(this.recordPath(sessionId), JSON.stringify(record, null, 2) + '\n')
    // Clear any independent explicit-title sidecar so a later explicit restore
    // never resurrects a pre-delete title.
    try {
      unlinkSync(this.titleSidecarPath(sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
