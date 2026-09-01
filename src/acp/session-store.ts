import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
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

type LegacySessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

/** One per-session record: either live state or a deletion tombstone. */
type SessionRecordFile =
  | { version: 1; deleted?: false; session: StoredSession }
  | { version: 1; deleted: true; sessionId: string }

function isStoredSession(value: unknown): value is StoredSession {
  const record = value as StoredSession | null | undefined
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.sessionId === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.sessionFile === 'string' &&
    typeof record.updatedAt === 'string'
  )
}

function parseRecord(path: string, raw: string, expectedSessionId: string): SessionRecordFile {
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
    if (record.sessionId !== expectedSessionId) {
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
  if (record.session.sessionId !== expectedSessionId) {
    throw new SessionStoreCorruptError(
      path,
      `live record sessionId ${record.session.sessionId} does not match ${expectedSessionId}`
    )
  }
  return { version: 1, session: record.session }
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

  private recordPath(sessionId: string): string {
    const encoded = Buffer.from(sessionId, 'utf-8').toString('base64url')
    // Path-safe and reversible for realistic ids (UUIDs); hash unusually long
    // ids so the file name stays within filesystem limits.
    const name = encoded.length <= 180 ? encoded : `sha256-${createHash('sha256').update(sessionId).digest('hex')}`
    return join(this.stateDir, `${name}.json`)
  }

  private readLegacy(sessionId: string): StoredSession | null {
    const raw = readFileOrNull(this.legacyMapPath)
    if (raw === null) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new SessionStoreCorruptError(this.legacyMapPath, `invalid JSON: ${String((e as Error)?.message ?? e)}`)
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
      throw new SessionStoreCorruptError(this.legacyMapPath, 'unknown map shape or version')
    }

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
    if (record) return record.deleted ? null : record.session
    return this.readLegacy(sessionId)
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
      let parsed: unknown
      try {
        parsed = JSON.parse(legacyRaw)
      } catch (e) {
        throw new SessionStoreCorruptError(this.legacyMapPath, `invalid JSON: ${String((e as Error)?.message ?? e)}`)
      }
      const legacy = parsed as LegacySessionMapFile
      if (!legacy || legacy.version !== 1 || !legacy.sessions || typeof legacy.sessions !== 'object') {
        throw new SessionStoreCorruptError(this.legacyMapPath, 'unknown map shape or version')
      }
      for (const [id, session] of Object.entries(legacy.sessions)) {
        if (!isStoredSession(session) || session.sessionId !== id) {
          throw new SessionStoreCorruptError(this.legacyMapPath, `invalid legacy entry for ${id}`)
        }
        byId.set(id, session)
      }
    }

    let names: string[] = []
    try {
      names = (await readdir(this.stateDir)).filter(name => name.endsWith('.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of names) {
      const path = join(this.stateDir, name)
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { deleted?: unknown; sessionId?: unknown; session?: unknown }
      const id = parsed.deleted === true ? parsed.sessionId : (parsed.session as StoredSession | undefined)?.sessionId
      if (typeof id !== 'string') throw new SessionStoreCorruptError(path, 'record without sessionId')
      const record = parseRecord(path, raw, id)
      if (record.deleted) byId.delete(id)
      else byId.set(id, record.session)
    }
    return [...byId.values()]
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    // Refuse to replace malformed state. This validation is intentionally per
    // record and does not introduce a shared read-modify-write file.
    this.readDirect(entry.sessionId)
    const record: SessionRecordFile = {
      version: 1,
      session: {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        sessionFile: entry.sessionFile,
        updatedAt: new Date().toISOString()
      }
    }
    writeFileAtomic(this.recordPath(entry.sessionId), JSON.stringify(record, null, 2) + '\n')
  }

  delete(sessionId: string): void {
    // As with upsert, corruption must remain visible for manual repair rather
    // than being hidden by a valid-looking replacement.
    this.readDirect(sessionId)
    // A tombstone (not unlink) is required: unlinking the direct record would
    // let a stale legacy-map entry resurrect the session on the next get().
    const record: SessionRecordFile = { version: 1, deleted: true, sessionId }
    writeFileAtomic(this.recordPath(sessionId), JSON.stringify(record, null, 2) + '\n')
  }
}
