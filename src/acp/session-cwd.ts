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

function displayPath(path: string): string {
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
export function sessionCwdsEquivalent(left: string, right: string, flavor?: PathFlavor): boolean {
  if (flavor) return normalizeCwdForComparison(left, flavor) === normalizeCwdForComparison(right, flavor)
  return (
    normalizeCwdForComparison(physicalPath(left) ?? left) === normalizeCwdForComparison(physicalPath(right) ?? right)
  )
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
