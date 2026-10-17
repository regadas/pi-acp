import { RequestError } from '@agentclientprotocol/sdk'
import { statSync, type Stats } from 'node:fs'
import { isAbsolute } from 'node:path'
import { displayPath, resolveCwdForComparison } from './session-cwd.js'

/**
 * Filesystem identity of an existing directory: the stat dev/ino pair, which
 * follows symlinks and `..` physically on every supported runtime. Bun's
 * `realpathSync.native` lexically collapses `symlink/..`, so resolved paths
 * are not a reliable directory identity there. Null when stat cannot supply
 * one, in which case callers fall back to path comparison.
 */
function directoryIdentity(path: string): string | null {
  try {
    const stats = statSync(path)
    if (!stats.isDirectory()) return null
    return identityFromStats(stats)
  } catch {
    return null
  }
}

function identityFromStats(stats: Stats): string | null {
  return stats.dev !== 0 || stats.ino !== 0 ? `${stats.dev}:${stats.ino}` : null
}

type DirectoryKey = { identity: string | null; comparison: string }

function directoryKey(path: string, identity?: string | null): DirectoryKey {
  return { identity: identity ?? directoryIdentity(path), comparison: resolveCwdForComparison(path) }
}

/** Two directories alias each other: exact filesystem identity when both sides have one, resolved paths otherwise. */
function directoriesAlias(left: DirectoryKey, right: DirectoryKey): boolean {
  if (left.identity !== null && right.identity !== null) return left.identity === right.identity
  return left.comparison === right.comparison
}

/**
 * Validate the ACP `additionalDirectories` request field against the session
 * cwd. Every entry must be an absolute existing directory; entries that alias
 * the cwd or an already-accepted root (including through symlink resolution)
 * are dropped, keeping the first occurrence. Returns the accepted roots in
 * request order; omitted/empty input yields [].
 */
export function normalizeAdditionalDirectories(cwd: string, additionalDirectories: unknown): string[] {
  if (additionalDirectories == null) return []
  if (!Array.isArray(additionalDirectories)) {
    throw RequestError.invalidParams(
      { reason: 'ADDITIONAL_DIRECTORIES_INVALID' },
      'additionalDirectories must be an array of absolute directory paths.'
    )
  }

  const seen: DirectoryKey[] = [directoryKey(cwd)]
  const roots: string[] = []
  for (const [index, candidate] of additionalDirectories.entries()) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
      throw RequestError.invalidParams(
        { reason: 'ADDITIONAL_DIRECTORY_NOT_ABSOLUTE' },
        `additionalDirectories[${index}] must be an absolute directory path: ${displayPath(String(candidate))}`
      )
    }

    let stats
    try {
      stats = statSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === 'ENOENT' ? 'ADDITIONAL_DIRECTORY_NOT_FOUND' : 'ADDITIONAL_DIRECTORY_UNAVAILABLE'
      throw RequestError.invalidParams(
        { reason, ...(code ? { code } : {}) },
        `additionalDirectories[${index}] ${reason === 'ADDITIONAL_DIRECTORY_NOT_FOUND' ? 'does not exist' : 'is not accessible'}: ${displayPath(candidate)}`
      )
    }

    if (!stats.isDirectory()) {
      throw RequestError.invalidParams(
        { reason: 'ADDITIONAL_DIRECTORY_NOT_DIRECTORY' },
        `additionalDirectories[${index}] must be an existing directory: ${displayPath(candidate)}`
      )
    }

    const key = directoryKey(candidate, identityFromStats(stats))
    if (seen.some(entry => directoriesAlias(entry, key))) continue
    seen.push(key)
    roots.push(candidate)
  }
  return roots
}

/** Ordered comparison of root lists by resolved identity (symlink/alias aware). */
export function workspaceRootsEquivalent(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((root, index) => directoriesAlias(directoryKey(root), directoryKey(right[index]!)))
  )
}
