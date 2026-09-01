import { spawn } from 'node:child_process'
import { buildPiInvocation } from './command.js'

/** agent_settled is the lifecycle floor; newer commands use explicit fallbacks. */
export const MIN_PI_VERSION = '0.80.4'

export const PI_FEATURE_MIN_VERSION = {
  agentSettled: '0.80.4',
  prompt: '0.80.4',
  abort: '0.80.4',
  stateAndModels: '0.80.4',
  modelAndThinkingMutation: '0.80.4',
  queueModes: '0.80.4',
  compaction: '0.80.4',
  sessionStatsAndExport: '0.80.4',
  getEntries: '0.80.4',
  getCommands: '0.80.4',
  extensionUi: '0.80.4',
  getAvailableThinkingLevels: '0.81.0'
} as const

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

function versionFailure(command: string, cwd: string, detail: string): PiVersionError {
  return new PiVersionError(
    `Could not determine the pi version: \`${command} --version\` ${detail} from ${cwd}. ` +
      `pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event).`
  )
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function startVersionProbe(piCommand: string, cwd: string): VersionProbe {
  const controller = new AbortController()
  const signal = controller.signal
  const promise = new Promise<string | null>((resolve, reject) => {
    const invocation = buildPiInvocation(piCommand, ['--version'], { cwd })
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
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    })
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
      child.kill('SIGKILL')
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
            `Unsupported pi version ${version} (command: ${piCommand}). pi-acp requires pi >= ${MIN_PI_VERSION}, ` +
              'which adds the `agent_settled` RPC event used to close ACP prompt turns safely.'
          )
        })
        return
      }
      settle({ value: version })
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ error: versionFailure(piCommand, cwd, 'timed out') })
    }, 15_000)
    timer.unref?.()
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

export function assertSupportedPiVersion(
  piCommand: string,
  cwd = process.cwd(),
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  const cacheKey = JSON.stringify([piCommand, cwd])
  let probe = versionCache.get(cacheKey)
  if (!probe || probe.aborting) {
    probe = startVersionProbe(piCommand, cwd)
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
