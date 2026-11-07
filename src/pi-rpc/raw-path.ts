import { sep } from 'node:path'

/**
 * Append path segments without lexical normalization. A lexical `join`
 * collapses a trailing `..` before the OS resolves symlinks, so a base like
 * `/work/link/..` (which points at the physical directory it resolves to,
 * not the one the collapsed text names) would read or write in the wrong
 * location; keeping the raw segments lets stat/open resolve the same
 * physical file the unmodified path does. The separator is the native one
 * so supported Windows paths spell like a plain `join`.
 */
export function appendPathSegments(base: string, ...segments: string[]): string {
  const trailing = process.platform === 'win32' ? /[\\/]$/ : /\/$/
  let path = base
  for (const segment of segments) {
    path = trailing.test(path) ? path + segment : path + sep + segment
  }
  return path
}
