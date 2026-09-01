import { statSync } from 'node:fs'
import { platform as hostPlatform } from 'node:os'
import { win32 } from 'node:path'

export function defaultPiCommand(platform = hostPlatform()): string {
  return platform === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  return override ?? defaultPiCommand()
}

type FileExists = (path: string) => boolean

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

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
        ...pathValue.split(win32.delimiter).map(rawDir => {
          const dir = rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir
          return win32.resolve(cwd, dir || '.', normalized)
        })
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

export type PiInvocation = { executable: string; args: string[]; windowsVerbatimArguments?: boolean }

function cmdToken(value: string): string {
  // First quote for the batch launcher's argv parser, then escape cmd syntax.
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(/[()%!^"<>&|]/g, char => (char === '%' ? '%%' : `^${char}`))
}

/** Build an argv-safe invocation without Node's shell/string-concatenation mode. */
export function buildPiInvocation(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    fileExists?: FileExists
  } = {}
): PiInvocation | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command.trim())) {
    return { executable: command, args: [...args] }
  }

  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env
  const pathValue = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  const script = resolveWindowsScriptCommand(command, cwd, pathValue, opts.fileExists)
  if (!script) return null
  const commandProcessor = env.ComSpec || env.COMSPEC || 'cmd.exe'
  const commandLine = [script, ...args].map(cmdToken).join(' ')
  return {
    executable: commandProcessor,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  }
}
