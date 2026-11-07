import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { buildPiInvocation, findExecutableOnPath, isConcretePiEntry, type PiInvocation } from './command.js'
import { killProcessTree, killPosixProcessGroup } from './process-tree.js'

/** Owned ACP completion needs awaited agent_before_settle boundaries and delivered, retained system-prompt sections on extension-triggered runs. */
export const MIN_PI_VERSION = '1.2.0'
const MIN_PI_REASON =
  'awaited `agent_before_settle` boundaries and system-prompt section delivery on extension-triggered runs'

export class PiVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiVersionError'
  }
}

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parsePiVersion(raw: string): string | null {
  const cleaned = raw.trim().replace(/^v/i, '')
  return SEMVER_REGEX.test(cleaned) ? cleaned : null
}

type ParsedSemver = { base: [bigint, bigint, bigint]; prerelease: string[] }
function parseSemverParts(v: string): ParsedSemver {
  const normalized = parsePiVersion(v)
  if (!normalized) throw new TypeError(`Invalid semantic version: ${v}`)
  const withoutBuild = normalized.split('+')[0]!
  const dashIndex = withoutBuild.indexOf('-')
  const base = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split('.')
  const [major, minor, patch] = base.split('.').map(BigInt)
  return { base: [major!, minor!, patch!], prerelease }
}

export function comparePiVersions(a: string, b: string): number {
  const pa = parseSemverParts(a)
  const pb = parseSemverParts(b)
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1
    if (pa.base[i] < pb.base[i]) return -1
  }
  if (!pa.prerelease.length && !pb.prerelease.length) return 0
  if (!pa.prerelease.length) return 1
  if (!pb.prerelease.length) return -1
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const ia = pa.prerelease[i]
    const ib = pb.prerelease[i]
    if (ia === undefined) return -1
    if (ib === undefined) return 1
    const numericA = /^\d+$/.test(ia)
    const numericB = /^\d+$/.test(ib)
    if (numericA && numericB) {
      const na = BigInt(ia)
      const nb = BigInt(ib)
      if (na !== nb) return na < nb ? -1 : 1
    } else if (numericA) return -1
    else if (numericB) return 1
    else if (ia !== ib) return ia < ib ? -1 : 1
  }
  return 0
}

type VersionProbe = {
  promise: Promise<string | null>
  consumers: Set<symbol>
  aborting: boolean
  settled: boolean
  abort(): void
}

const versionCache = new Map<string, VersionProbe>()
export function clearPiVersionCacheForTests(): void {
  versionCache.clear()
}

// Mirrors the RPC child's bounded tree-kill grace (KILL_GRACE_MS in
// process.ts): one attempt, fail closed on an unconfirmed result.
const PROBE_TREE_KILL_TIMEOUT_MS = 2_000

function versionFailure(command: string, cwd: string, detail: string): PiVersionError {
  return new PiVersionError(
    `Could not determine the pi version: \`${command} --version\` ${detail} from ${cwd}. ` +
      `pi-acp requires pi >= ${MIN_PI_VERSION} (for ${MIN_PI_REASON}).`
  )
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function startVersionProbe(piCommand: string, cwd: string, invocation: PiInvocation | null): VersionProbe {
  const controller = new AbortController()
  const signal = controller.signal
  const promise = new Promise<string | null>((resolve, reject) => {
    if (!invocation) return resolve(null)

    let stdout = ''
    let stderr = ''
    let settled = false
    let abortedReason: unknown
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // The probe child owns a dedicated POSIX process group, so a wrapper's
      // pi grandchild holding the stdio pipes can be group-killed on abort.
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    })
    // Windows tree kill is pid-addressed: never after exit (see killTreeTargetsRootPid).
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    const killProbeTree = () => {
      const kill =
        child.pid === undefined
          ? null
          : process.platform !== 'win32'
            ? killPosixProcessGroup(child.pid, 0, PROBE_TREE_KILL_TIMEOUT_MS)
            : !exited && invocation.windowsScriptWrapper === true
              ? killProcessTree(child.pid, PROBE_TREE_KILL_TIMEOUT_MS)
              : null
      if (!kill) {
        child.kill('SIGKILL')
        return
      }
      void kill.then(
        result => {
          if (!result.confirmed) console.error(`pi-acp: version probe tree kill unconfirmed (${result.reason})`)
        },
        () => {}
      )
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const settle = (outcome: { value: string | null } | { error: unknown }) => {
      if (settled) return
      settled = true
      cleanup()
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.value)
    }
    const onAbort = () => {
      if (settled || abortedReason !== undefined) return
      abortedReason = abortReason(signal)
      killProbeTree()
    }
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
    child.once('error', error => {
      if (abortedReason !== undefined) {
        settle({ error: abortedReason })
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOEXEC') settle({ value: null })
      else settle({ error: versionFailure(piCommand, cwd, String(error)) })
    })
    child.once('close', (code, childSignal) => {
      if (settled) return
      if (abortedReason !== undefined) {
        settle({ error: abortedReason })
        return
      }
      const output = (stdout.trim() || stderr.trim()).slice(0, 120)
      if (code !== 0 || childSignal) {
        settle({
          error: versionFailure(
            piCommand,
            cwd,
            childSignal ? `was terminated by ${childSignal}` : `exited with status ${code}`
          )
        })
        return
      }
      const version = parsePiVersion(output)
      if (!version) {
        settle({ error: versionFailure(piCommand, cwd, `printed ${JSON.stringify(output)}`) })
        return
      }
      if (comparePiVersions(version, MIN_PI_VERSION) < 0) {
        settle({
          error: new PiVersionError(
            `Unsupported pi version ${version} (command: ${piCommand}). pi-acp requires pi >= ${MIN_PI_VERSION} ` +
              `for ${MIN_PI_REASON} used to keep ACP prompt turns open through owned async work.`
          )
        })
        return
      }
      settle({ value: version })
    })
    const timer = setTimeout(() => {
      killProbeTree()
      settle({ error: versionFailure(piCommand, cwd, 'timed out') })
    }, 15_000)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  const probe: VersionProbe = {
    promise,
    consumers: new Set(),
    aborting: false,
    settled: false,
    abort() {
      if (probe.aborting || probe.settled) return
      probe.aborting = true
      controller.abort()
    }
  }
  void promise.then(
    () => {
      probe.settled = true
    },
    () => {
      probe.settled = true
    }
  )
  return probe
}

function consumeVersionProbe(probe: VersionProbe, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  const consumer = Symbol('version-probe-consumer')
  probe.consumers.add(consumer)

  return new Promise<string | null>((resolve, reject) => {
    let finished = false
    let aborted = false
    const detach = () => {
      signal?.removeEventListener('abort', onAbort)
      probe.consumers.delete(consumer)
    }
    const finish = (outcome: { value: string | null } | { error: unknown }) => {
      if (finished) return
      finished = true
      detach()
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.value)
    }
    const onAbort = () => {
      if (finished || aborted) return
      aborted = true
      const reason = abortReason(signal!)
      detach()
      if (probe.consumers.size > 0 || probe.settled) {
        finished = true
        reject(reason)
        return
      }

      // The final owner waits for the shared child to close, preserving the
      // SessionManager shutdown guarantee. Other callers already detached.
      probe.abort()
      void probe.promise.then(
        () => finish({ error: reason }),
        () => finish({ error: reason })
      )
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    void probe.promise.then(
      value => {
        if (!aborted) finish({ value })
      },
      error => {
        if (!aborted) finish({ error })
      }
    )
    if (signal?.aborted) onAbort()
  })
}

/**
 * The probe cache key: what actually runs, not where the caller sits —
 * except where the same command can behave differently per cwd. Only the
 * default command's resolution is trusted as the concrete pi entry (a
 * bun/node runtime with the direct-JS pi entry as its argument, or a PATH
 * lookup landing on a concrete entry) and may share one probe across cwds;
 * explicit overrides are always keyed per cwd, because a forwarding launcher
 * script cannot be told from a concrete pi entry by shape. Relative
 * commands, Windows lookups, wrapper scripts and unresolved commands keep
 * the cwd in the key as well.
 */
function versionProbeCacheKey(
  piCommand: string,
  cwd: string,
  defaultCommand: boolean,
  invocation: PiInvocation | null
): unknown[] {
  if (!invocation) return ['unresolved', piCommand, cwd, defaultCommand]
  if (invocation.windowsScriptWrapper === true) {
    // The launcher script is embedded in the cmd.exe command line, but the
    // script itself can forward to a cwd-dependent pi.
    return [invocation.executable, invocation.args, cwd, defaultCommand]
  }
  if (invocation.executable !== piCommand) {
    // Bun reroute (default discovery only): both the runtime and the pi entry
    // are resolved absolute paths, so every cwd that resolves there shares
    // one probe.
    return [invocation.executable, invocation.args[0] ?? '', defaultCommand]
  }
  if (isAbsolute(piCommand)) {
    // An explicit absolute override may be a launcher forwarding to a
    // workspace-local pi; that cannot be told from a concrete pi entry by
    // shape, so the probe stays keyed per cwd.
    return [piCommand, cwd, defaultCommand]
  }
  if (process.platform === 'win32' || piCommand.includes('/') || piCommand.includes('\\')) {
    // Relative commands and Windows PATH lookups resolve against the cwd.
    return [piCommand, cwd, defaultCommand]
  }
  const resolved = findExecutableOnPath(piCommand, { cwd, env: process.env })
  // An unresolved command never keeps its probe (see the null purge in
  // assertSupportedPiVersion), so the key only separates it from resolved ones.
  if (!resolved) return ['unresolved', piCommand, cwd, defaultCommand]
  if (!defaultCommand) {
    // A bare explicit override is as untrusted as an absolute one: it may be
    // a forwarding launcher, so the probe stays keyed per cwd.
    return [resolved, cwd, defaultCommand]
  }
  // Default-discovery PATH resolution is the adapter's trusted entry point:
  // only a concrete entry shares its probe across cwds.
  return isConcretePiEntry(resolved) ? [resolved, defaultCommand] : [resolved, cwd, defaultCommand]
}

export function assertSupportedPiVersion(
  piCommand: string,
  cwd = process.cwd(),
  signal?: AbortSignal,
  defaultCommand = false
): Promise<string | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  // defaultCommand is part of the cache identity: the same command resolves
  // to a different runtime (Bun-preferred default vs verbatim override).
  const invocation = buildPiInvocation(piCommand, ['--version'], { cwd, defaultCommand })
  const cacheKey = JSON.stringify(versionProbeCacheKey(piCommand, cwd, defaultCommand, invocation))
  let probe = versionCache.get(cacheKey)
  if (!probe || probe.aborting) {
    probe = startVersionProbe(piCommand, cwd, invocation)
    versionCache.set(cacheKey, probe)
    void probe.promise.then(
      version => {
        if (version === null && versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey)
      },
      () => {
        if (versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey)
      }
    )
  }
  return consumeVersionProbe(probe, signal)
}
