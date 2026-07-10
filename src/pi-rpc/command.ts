import { statSync } from 'node:fs'
import { platform } from 'node:os'
import { win32 } from 'node:path'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  return override ?? defaultPiCommand()
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}

type FileExists = (path: string) => boolean

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a Windows command script using the command-search order relevant to
 * pi-acp: an explicit path is resolved from cwd, while a bare command searches
 * cwd first and then PATH. The injectable existence check keeps the Windows
 * path semantics deterministically testable on non-Windows hosts.
 */
export function resolveWindowsScriptCommand(
  command: string,
  cwd: string,
  pathValue: string,
  fileExists: FileExists = isFile
): string | null {
  const normalized = command.trim()
  const explicitPath = win32.isAbsolute(normalized) || /[\\/:]/.test(normalized)
  const candidates = explicitPath
    ? [win32.resolve(cwd, normalized)]
    : [
        win32.resolve(cwd, normalized),
        ...pathValue.split(win32.delimiter).map(dir => win32.resolve(dir || cwd, normalized))
      ]

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (fileExists(candidate)) return candidate
  }
  return null
}

/** Resolve shell-based Windows launchers before probing them with --version. */
export function resolvePiCommandForVersionProbe(cmd: string, cwd: string): string | null {
  if (!shouldUseShellForPiCommand(cmd)) return cmd

  const pathValue = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  return resolveWindowsScriptCommand(cmd, cwd, pathValue)
}
