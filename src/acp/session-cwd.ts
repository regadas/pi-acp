import { RequestError } from '@agentclientprotocol/sdk'
import { realpathSync, statSync, type Stats } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PathFlavor = 'posix' | 'win32'

const MAX_DISPLAY_PATH_LENGTH = 240

function runtimePathFlavor(): PathFlavor {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function pathApi(flavor: PathFlavor) {
  return flavor === 'win32' ? win32 : posix
}

/** Bounded, JSON-quoted path display for error messages (reused across seam errors). */
export function displayPath(path: string): string {
  const clipped = path.length <= MAX_DISPLAY_PATH_LENGTH ? path : `${path.slice(0, MAX_DISPLAY_PATH_LENGTH - 3)}...`
  return JSON.stringify(clipped)
}

export function normalizeCwdForComparison(cwd: string, flavor: PathFlavor = runtimePathFlavor()): string {
  const api = pathApi(flavor)
  const normalized = api.normalize(cwd)
  const rootLength = api.parse(normalized).root.length
  const trailingSeparators = flavor === 'win32' ? /[\\/]+$/ : /\/+$/
  const withoutTrailingSeparators =
    normalized.length > rootLength ? normalized.replace(trailingSeparators, '') : normalized
  return flavor === 'win32' ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators
}

function physicalPath(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * Lexical `..` collapse can name a physically different directory when an
 * earlier segment is a symlink, so a path that exists on disk is compared by
 * its resolved identity (which also equates aliases such as macOS
 * `/tmp` and `/private/tmp`). Paths that cannot be resolved — deleted session
 * directories in `session/list` — and callers that pass an explicit flavor
 * fall back to deterministic lexical comparison.
 */
export function resolveCwdForComparison(cwd: string, flavor?: PathFlavor): string {
  return normalizeCwdForComparison(flavor ? cwd : (physicalPath(cwd) ?? cwd), flavor)
}

/**
 * Filesystem identity of an existing directory: the stat dev/ino pair, which
 * follows symlinks and `..` physically on every supported runtime. Bun's
 * `realpathSync.native` lexically collapses `symlink/..`, so resolved paths
 * are not a reliable directory identity there. Null when stat cannot supply
 * one, in which case callers fall back to path comparison.
 */
export function directoryIdentity(path: string): string | null {
  try {
    const stats = statSync(path)
    if (!stats.isDirectory()) return null
    return identityFromStats(stats)
  } catch {
    return null
  }
}

export function identityFromStats(stats: Stats): string | null {
  return stats.dev !== 0 || stats.ino !== 0 ? `${stats.dev}:${stats.ino}` : null
}

export type DirectoryKey = { readonly identity: string | null; readonly comparison: string }

export function directoryKey(path: string, identity?: string | null): DirectoryKey {
  return { identity: identity ?? directoryIdentity(path), comparison: resolveCwdForComparison(path) }
}

/** Two directories alias each other: exact filesystem identity when both sides have one, resolved paths otherwise. */
export function directoriesAlias(left: DirectoryKey, right: DirectoryKey): boolean {
  if (left.identity !== null && right.identity !== null) return left.identity === right.identity
  return left.comparison === right.comparison
}

/**
 * Primary cwd matching: existing directories compare by filesystem identity
 * (realpath equivalence is preserved on runtimes with a truthful realpath,
 * and Bun's lexically collapsing realpath cannot equate different real
 * directories), while deleted directories fall back to resolved-path
 * comparison. Explicit flavors stay purely lexical.
 */
export function sessionCwdsEquivalent(left: string, right: string, flavor?: PathFlavor): boolean {
  if (flavor) return resolveCwdForComparison(left, flavor) === resolveCwdForComparison(right, flavor)
  return directoriesAlias(directoryKey(left), directoryKey(right))
}

export function assertValidSessionCwd(cwd: string): void {
  if (!pathApi(runtimePathFlavor()).isAbsolute(cwd)) {
    throw RequestError.invalidParams(
      { reason: 'CWD_NOT_ABSOLUTE' },
      `cwd must be an absolute path: ${displayPath(cwd)}`
    )
  }

  let stats: Stats
  try {
    stats = statSync(cwd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'CWD_NOT_FOUND' : 'CWD_UNAVAILABLE'
    const message =
      code === 'ENOENT' ? `cwd does not exist: ${displayPath(cwd)}` : `cwd is not accessible: ${displayPath(cwd)}`
    throw RequestError.invalidParams({ reason, ...(code ? { code } : {}) }, message)
  }

  if (!stats.isDirectory()) {
    throw RequestError.invalidParams(
      { reason: 'CWD_NOT_DIRECTORY' },
      `cwd must be an existing directory: ${displayPath(cwd)}`
    )
  }
}
