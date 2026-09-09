import { createReadStream } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { getAgentDir, getMergedPiSettings } from './pi-settings.js'
import { sessionCwdsEquivalent } from './session-cwd.js'
import { SessionStore, type StoredSession } from './session-store.js'

export type SessionRecord = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const HEADER_LIMIT = 1024 * 1024
const METADATA_RECORD_LIMIT = 1024 * 1024
// ponytail: cap each history scan at 8 MiB; add an on-disk metadata index if exact deep-history titles matter.
const METADATA_FILE_LIMIT = 8 * 1024 * 1024
const TITLE_LIMIT = 80
const RESOURCE_EXHAUSTION_CODES = new Set(['EMFILE', 'ENFILE', 'ENOMEM'])

function rethrowResourceExhaustion(error: unknown): void {
  if (RESOURCE_EXHAUSTION_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
}

function expandDirectory(value: string, cwd: string): string {
  const expanded =
    value === '~'
      ? homedir()
      : value.startsWith('~/') || value.startsWith('~\\')
        ? join(homedir(), value.slice(2))
        : value
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

export function defaultSessionDirectory(cwd: string, agentDir = getAgentDir()): string {
  const encoded = resolve(cwd)
    .replace(/^[/\\]+/, '')
    .replace(/[/\\:]/g, '-')
  return join(agentDir, 'sessions', `--${encoded}--`)
}

export function resolveSessionDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  agentDir = getAgentDir()
): { path: string; custom: boolean } {
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (fromEnv) return { path: expandDirectory(fromEnv, cwd), custom: true }
  const configured = getMergedPiSettings(cwd).sessionDir
  if (typeof configured === 'string' && configured.trim()) {
    return { path: expandDirectory(configured.trim(), cwd), custom: true }
  }
  return { path: defaultSessionDirectory(cwd, agentDir), custom: false }
}

async function readBounded(path: string, maxBytes: number, position = 0): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, position)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    rethrowResourceExhaustion(error)
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function validatedHeader(path: string, requestedId?: string): Promise<{ sessionId: string; cwd: string } | null> {
  const head = await readBounded(path, HEADER_LIMIT)
  if (!head) return null
  const newline = head.indexOf('\n')
  if (newline < 0 && Buffer.byteLength(head) >= HEADER_LIMIT) return null
  try {
    const value = JSON.parse((newline < 0 ? head : head.slice(0, newline)).trim()) as Record<string, unknown>
    if (value.type !== 'session' || typeof value.id !== 'string' || typeof value.cwd !== 'string' || !value.cwd)
      return null
    if (requestedId !== undefined && value.id !== requestedId) return null
    return { sessionId: value.id, cwd: value.cwd }
  } catch {
    return null
  }
}

function userMessageTitle(value: Record<string, unknown>): string | null {
  const message = value.message as { role?: unknown; content?: unknown } | undefined
  if (value.type !== 'message' || message?.role !== 'user') return null
  if (typeof message.content === 'string') return message.content.slice(0, TITLE_LIMIT)
  if (!Array.isArray(message.content)) return null
  const block = message.content.find(item => (item as { type?: unknown }).type === 'text') as
    | { text?: unknown }
    | undefined
  return typeof block?.text === 'string' ? block.text.slice(0, TITLE_LIMIT) : null
}

type MetadataScanState = { truncated: boolean }

async function* boundedRecords(path: string, state: MetadataScanState): AsyncGenerator<string> {
  // Read one byte past the limit so an exact full window is distinguishable from EOF.
  const input = createReadStream(path, { start: 0, end: METADATA_FILE_LIMIT })
  let remaining = METADATA_FILE_LIMIT
  let chunks: Buffer[] = []
  let length = 0
  let oversized = false

  const append = (chunk: Buffer) => {
    if (oversized || chunk.length === 0) return
    if (length + chunk.length > METADATA_RECORD_LIMIT) {
      chunks = []
      length = 0
      oversized = true
      return
    }
    chunks.push(Buffer.from(chunk))
    length += chunk.length
  }

  const take = (): string | null => {
    if (oversized) return null
    const record = Buffer.concat(chunks, length)
    const end = record.at(-1) === 0x0d ? record.length - 1 : record.length
    return record.subarray(0, end).toString('utf8')
  }

  for await (const raw of input) {
    let chunk = raw as Buffer
    if (chunk.length > remaining) {
      chunk = chunk.subarray(0, remaining)
      state.truncated = true
    }
    remaining -= chunk.length

    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue
      append(chunk.subarray(start, index))
      const record = take()
      if (record !== null) yield record
      chunks = []
      length = 0
      oversized = false
      start = index + 1
    }
    append(chunk.subarray(start))
    if (state.truncated) break
  }

  if (!state.truncated && chunks.length && !oversized) yield take()!
}

async function scanMetadata(
  path: string
): Promise<{ title: string | null; updatedAt: string | null; truncated: boolean } | null> {
  let explicitTitle: string | null = null
  let firstUserTitle: string | null = null
  let latestMessageTimestamp: string | null = null
  let anyTimestamp: string | null = null
  const state: MetadataScanState = { truncated: false }
  try {
    for await (const line of boundedRecords(path, state)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.type === 'session_info' && typeof value.name === 'string' && value.name.trim()) {
          explicitTitle = value.name.trim().slice(0, TITLE_LIMIT)
        }
        firstUserTitle ??= userMessageTitle(value)
        if (typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))) {
          const timestamp = new Date(value.timestamp).toISOString()
          anyTimestamp = timestamp
          if (value.type === 'message') latestMessageTimestamp = timestamp
        }
      } catch {
        // Ignore malformed records without losing metadata later in the file.
      }
    }
  } catch (error) {
    rethrowResourceExhaustion(error)
    return null
  }
  return {
    title: explicitTitle ?? firstUserTitle,
    updatedAt: latestMessageTimestamp ?? anyTimestamp,
    truncated: state.truncated
  }
}

function isNewer(candidate: SessionRecord, previous: SessionRecord): boolean {
  const timestampOrder = (candidate.updatedAt ?? '').localeCompare(previous.updatedAt ?? '')
  return timestampOrder > 0 || (timestampOrder === 0 && candidate.sessionFile.localeCompare(previous.sessionFile) > 0)
}

async function project(
  path: string,
  requestedId?: string,
  knownHeader?: { sessionId: string; cwd: string }
): Promise<SessionRecord | null> {
  const header = knownHeader ?? (await validatedHeader(path, requestedId))
  if (!header) return null
  let mtime: Date | null = null
  try {
    mtime = (await stat(path)).mtime
  } catch (error) {
    rethrowResourceExhaustion(error)
    return null
  }
  const metadata = await scanMetadata(path)
  const title = metadata?.title ?? null
  const updatedAt = metadata?.truncated
    ? (mtime?.toISOString() ?? null)
    : (metadata?.updatedAt ?? mtime?.toISOString() ?? null)
  return { ...header, title, updatedAt, sessionFile: path }
}

function sessionDiscoveryRoot(cwd: string, env: NodeJS.ProcessEnv, agentDir: string): string {
  const resolved = resolveSessionDirectory(cwd, env, agentDir)
  return resolved.custom ? resolved.path : join(agentDir, 'sessions')
}

function addStoredDiscoveryRoot(
  roots: Set<string>,
  stored: StoredSession,
  env: NodeJS.ProcessEnv,
  agentDir: string
): void {
  const configuredRoot = sessionDiscoveryRoot(stored.cwd, env, agentDir)
  const fromRoot = relative(resolve(configuredRoot), resolve(stored.sessionFile))
  roots.add(!fromRoot.startsWith('..') && !isAbsolute(fromRoot) ? configuredRoot : dirname(stored.sessionFile))
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      rethrowResourceExhaustion(error)
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  return files
}

/** One authority for discovery, validated adapter records, and safe deletion. */
export class SessionRepository {
  constructor(
    readonly store = new SessionStore(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly agentDir = getAgentDir()
  ) {}

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    this.store.upsert(entry)
  }

  tombstone(sessionId: string): void {
    this.store.delete(sessionId)
  }

  stored(sessionId: string): StoredSession | null {
    return this.store.get(sessionId)
  }

  private async matchingRecords(sessionId: string, cwd?: string): Promise<SessionRecord[]> {
    const stored = this.store.get(sessionId)
    const paths = new Set<string>()
    const roots = new Set<string>()
    if (stored) {
      paths.add(stored.sessionFile)
      addStoredDiscoveryRoot(roots, stored, this.env, this.agentDir)
    }
    if (cwd || !stored) roots.add(sessionDiscoveryRoot(cwd ?? process.cwd(), this.env, this.agentDir))
    for (const root of roots) for (const file of await jsonlFiles(root)) paths.add(file)

    const records: SessionRecord[] = []
    for (const path of paths) {
      const candidate = await project(path, sessionId)
      if (candidate) records.push(candidate)
    }
    return records
  }

  async find(sessionId: string, cwd?: string): Promise<SessionRecord | null> {
    const stored = this.store.get(sessionId)
    // Custom stores are test/embedder seams; the production SessionStore is
    // always validated against the exact JSONL header before use.
    if (stored && !(this.store instanceof SessionStore)) {
      return { ...stored, title: null, updatedAt: stored.updatedAt ?? null }
    }

    let newest: SessionRecord | null = null
    for (const candidate of await this.matchingRecords(sessionId, cwd)) {
      if (!newest || isNewer(candidate, newest)) newest = candidate
    }
    if (!newest) return null
    this.store.upsert({ sessionId: newest.sessionId, cwd: newest.cwd, sessionFile: newest.sessionFile })
    return newest
  }

  async list(cwd?: string): Promise<SessionRecord[]> {
    const paths = new Set<string>()
    const roots = new Set([sessionDiscoveryRoot(cwd ?? process.cwd(), this.env, this.agentDir)])
    for (const stored of await this.store.list()) {
      paths.add(stored.sessionFile)
      addStoredDiscoveryRoot(roots, stored, this.env, this.agentDir)
    }
    for (const root of roots) for (const file of await jsonlFiles(root)) paths.add(file)
    // Filter identities, not records: a newer foreign duplicate must still win
    // deduplication, rather than resurrecting an older cwd-scoped copy.
    const headers = new Map<string, { sessionId: string; cwd: string }>()
    const scopedIds = new Set<string>()
    for (const path of paths) {
      const header = await validatedHeader(path)
      if (!header) continue
      headers.set(path, header)
      if (!cwd || sessionCwdsEquivalent(header.cwd, cwd)) scopedIds.add(header.sessionId)
    }
    const records: SessionRecord[] = []
    for (const [path, header] of headers) {
      if (!scopedIds.has(header.sessionId)) continue
      const record = await project(path, undefined, header)
      if (record) records.push(record)
    }
    const byId = new Map<string, SessionRecord>()
    for (const record of records) {
      const previous = byId.get(record.sessionId)
      if (!previous || isNewer(record, previous)) byId.set(record.sessionId, record)
    }
    return [...byId.values()]
      .filter(record => !cwd || sessionCwdsEquivalent(record.cwd, cwd))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.sessionId.localeCompare(b.sessionId))
  }

  async delete(sessionId: string): Promise<string | null> {
    const records = await this.matchingRecords(sessionId)
    let newest: SessionRecord | null = null
    for (const record of records) {
      if (!newest || isNewer(record, newest)) newest = record
      try {
        await unlink(record.sessionFile)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.store.delete(sessionId)
    return newest?.sessionFile ?? null
  }
}
