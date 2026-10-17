import { RequestError } from '@agentclientprotocol/sdk'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { directoriesAlias, directoryKey, displayPath, identityFromStats, type DirectoryKey } from './session-cwd.js'

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
