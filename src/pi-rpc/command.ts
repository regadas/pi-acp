import { accessSync, closeSync, constants as fsConstants, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { platform as hostPlatform } from 'node:os'
import { posix, win32 } from 'node:path'

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

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
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

/**
 * POSIX PATH lookup with execvp semantics: an absent PATH uses the system
 * default search path (as Node documents for spawn) and empty entries search
 * the cwd. Candidates are joined without lexical normalization because `..`
 * must resolve through symlinked PATH entries the way the kernel does, and
 * only the exact `PATH` key is read (`Path` must not override it on POSIX).
 */
export function findExecutableOnPath(name: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null {
  const cwd = (opts?.cwd ?? process.cwd()).replace(/\/+$/, '')
  const env = opts?.env ?? process.env
  const pathValue = env.PATH ?? '/usr/bin:/bin'
  for (const dir of pathValue.split(posix.delimiter)) {
    const base = dir === '' ? cwd : posix.isAbsolute(dir) ? dir : `${cwd}/${dir}`
    const candidate = `${base}/${name}`
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isJavaScriptEntry(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(path)
}

/** Reads the `#!` interpreter line; null for non-shebang files or lines longer than the probe. */
function readShebangLine(path: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(512)
    const length = readSync(fd, head, 0, head.length, 0)
    const text = head.subarray(0, length).toString('latin1')
    if (!text.startsWith('#!')) return null
    const newline = text.indexOf('\n')
    if (newline === -1 && length === head.length) return null
    return text.slice(2, newline === -1 ? undefined : newline).trim()
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Only entries with a bare Node/Bun shebang reroute to Bun: interpreter flags
 * (`env -S node --flag`) and unrecognized shebangs keep their configured
 * runtime instead of guessing at Bun compatibility.
 */
function isBunRunnableEntry(path: string): boolean {
  if (!isJavaScriptEntry(path)) return false
  const interpreter = readShebangLine(path)
  if (interpreter === null) return false
  return /^\/\S*\/env[ \t]+(?:node|bun)$/.test(interpreter) || /^\/\S*\/(?:node|bun)$/.test(interpreter)
}

/**
 * Default direct-JavaScript Pi installs (npm symlink to a .js entry) launch
 * under Bun when available: same RPC behavior, faster startup. Shell
 * launchers, standalone binaries and anything unresolvable keep their own
 * runtime, so the existing launch path is unchanged when Bun is absent.
 */
function bunRuntimeInvocation(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): PiInvocation | null {
  const bun = findExecutableOnPath('bun', { cwd, env })
  if (!bun) return null
  const piEntry = findExecutableOnPath(command, { cwd, env })
  if (!piEntry) return null
  // Bun's realpathSync collapses `..` lexically, so a candidate containing
  // `..` can resolve to a different entry than the original command would
  // launch (hardlinked entries share inode identity, so stat cannot tell
  // them apart). Keep the original command for those candidates.
  if (piEntry.split('/').includes('..')) return null
  let resolved: string
  try {
    resolved = realpathSync.native(piEntry)
  } catch {
    return null
  }
  return isBunRunnableEntry(resolved) ? { executable: bun, args: [resolved, ...args] } : null
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
    /** Default-command discovery (no user override): a direct-JS Pi install may run under Bun. */
    defaultCommand?: boolean
  } = {}
): PiInvocation | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') {
    if (opts.defaultCommand) {
      const viaBun = bunRuntimeInvocation(command, args, opts.cwd ?? process.cwd(), opts.env ?? process.env)
      if (viaBun) return viaBun
    }
    return { executable: command, args: [...args] }
  }
  if (!/\.(?:cmd|bat)$/i.test(command.trim())) {
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
