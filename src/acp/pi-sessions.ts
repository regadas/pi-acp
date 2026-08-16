import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { getAgentDir } from './pi-settings.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024
// Fallback-title scans read at most this much of a session file's head; the
// first user message is expected there and huge files must not be read whole.
const TITLE_HEAD_BYTES = 256 * 1024

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function readDirectory(dir: string): import('node:fs').Dirent[] {
  try {
    const entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'utf8'
    }) as unknown as import('node:fs').Dirent[]
    return entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  } catch {
    return []
  }
}

function walkJsonlFiles(dir: string, out: string[]): void {
  for (const entry of readDirectory(dir)) {
    const name = String(entry.name)
    const path = join(dir, name)
    try {
      if (entry.isDirectory()) walkJsonlFiles(path, out)
      else if (entry.isFile() && name.endsWith('.jsonl')) out.push(path)
    } catch {
      // A vanished or unreadable entry must not abort discovery.
    }
  }
}

/** Bounded head read; returns null (never throws) for vanished/unreadable files. */
function readHead(path: string, maxBytes: number): string | null {
  let fd: number
  try {
    // openSync itself throws for vanished (ENOENT) or unreadable (EACCES)
    // files; one bad file must not break an entire directory scan.
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    return buf.subarray(0, n).toString('utf-8')
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const s = readHead(path, DEFAULT_HEAD_BYTES)
  if (s === null) return null
  const idx = s.indexOf('\n')
  return idx === -1 ? s.trim() : s.slice(0, idx).trim()
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function pickTitleFromHead(path: string): string | null {
  // Bounded fallback: retain the latest early session name, otherwise the
  // first user message. Never scan the middle of a large session file.
  const head = readHead(path, TITLE_HEAD_BYTES)
  if (head === null) return null

  const lines = head.split(/\r?\n/)
  if (lines.length > 1) lines.pop()

  let sessionName: string | null = null
  let firstUserMessage: string | null = null
  for (const line0 of lines) {
    const line = line0.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        sessionName = obj.name.trim()
        continue
      }
      if (firstUserMessage || obj?.type !== 'message' || obj?.message?.role !== 'user') continue

      const content = obj?.message?.content
      if (typeof content === 'string') firstUserMessage = content.slice(0, 80)
      else if (Array.isArray(content)) {
        const text = content.find((block: any) => block?.type === 'text' && typeof block?.text === 'string')
        if (text?.text) firstUserMessage = String(text.text).slice(0, 80)
      }
    } catch {
      // Ignore malformed or truncated records inside the bounded head.
    }
  }

  return sessionName ?? firstUserMessage
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    // Isolate every file: one vanished (ENOENT race) or unreadable session
    // file must not abort the whole listing.
    try {
      const first = readFirstLine(file)
      if (!first) continue
      const header = parseSessionHeader(first)
      if (!header) continue

      let updatedAt: string | null = null

      let title: string | null = null
      try {
        const tail = readTail(file)
        title = pickTitleFromTail(tail)
        updatedAt = pickUpdatedAtFromTail(tail)
      } catch {
        // ignore
      }

      // Fallback for updatedAt when we couldn't parse timestamps from tail.
      if (!updatedAt) {
        try {
          updatedAt = statSync(file).mtime.toISOString()
        } catch {
          updatedAt = null
        }
      }

      if (!title) title = pickTitleFromHead(file)

      items.push({
        sessionId: header.sessionId,
        cwd: header.cwd,
        title,
        updatedAt,
        sessionFile: file
      })
    } catch {
      // ignore this file
    }
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa) || a.sessionId.localeCompare(b.sessionId) || a.sessionFile.localeCompare(b.sessionFile)
  })

  return items
}

type FindPiSessionOptions = {
  /** Local deterministic test seam; production callers leave this unset. */
  sessionsDir?: string
  onDirectoryVisited?: (dir: string) => void
}

function findPiSessionUnder(
  sessionId: string,
  dir: string,
  onDirectoryVisited?: (dir: string) => void
): PiSessionListItem | null {
  onDirectoryVisited?.(dir)
  for (const entry of readDirectory(dir)) {
    const name = String(entry.name)
    const path = join(dir, name)
    try {
      if (entry.isDirectory()) {
        const found = findPiSessionUnder(sessionId, path, onDirectoryVisited)
        if (found) return found
        continue
      }
      if (!entry.isFile() || !name.endsWith('.jsonl')) continue

      const first = readFirstLine(path)
      if (!first) continue
      const header = parseSessionHeader(first)
      if (!header || header.sessionId !== sessionId) continue
      return {
        sessionId: header.sessionId,
        cwd: header.cwd,
        title: null,
        updatedAt: null,
        sessionFile: path
      }
    } catch {
      // Isolate a vanished/unreadable entry and continue the targeted walk.
    }
  }
  return null
}

export function findPiSession(sessionId: string, options: FindPiSessionOptions = {}): PiSessionListItem | null {
  // Read headers while walking and return immediately on a match. Unlike
  // listPiSessions this neither collects every path nor reads title/tail data.
  return findPiSessionUnder(sessionId, options.sessionsDir ?? getPiSessionsDir(), options.onDirectoryVisited)
}
