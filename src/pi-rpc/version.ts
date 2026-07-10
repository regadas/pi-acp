import { spawnSync } from 'node:child_process'
import { shouldUseShellForPiCommand } from './command.js'

/**
 * Minimum pi version supported by this adapter.
 *
 * The ACP `session/prompt` lifecycle relies on pi's `agent_settled` RPC event
 * (added in pi 0.80.4). `agent_end` only marks a low-level agent run boundary:
 * pi may continue with automatic retries, compaction retries, and queued
 * continuations afterwards, and only `agent_settled` marks the fully settled
 * prompt. Completing the ACP turn at `agent_end` produces protocol-violating
 * out-of-turn `session/update` notifications, while waiting for
 * `agent_settled` on an older pi would hang forever. We therefore fail closed
 * with a clear error instead of silently misbehaving on unsupported versions.
 */
export const MIN_PI_VERSION = '0.80.4'

export class PiVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiVersionError'
  }
}

/** Parse `pi --version` output into a bare semver string, or null. */
export function parsePiVersion(raw: string): string | null {
  const cleaned = raw.trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(cleaned) ? cleaned : null
}

/** Compare two x.y.z versions (pre-release/build metadata is ignored). */
export function comparePiVersions(a: string, b: string): number {
  const pa = a
    .split(/[.+-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.+-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

const versionCache = new Map<string, string>()

/** Test seam: clear the per-process pi version cache. */
export function clearPiVersionCacheForTests(): void {
  versionCache.clear()
}

/**
 * Verify the resolved pi command (including `PI_ACP_PI_COMMAND` overrides)
 * satisfies {@link MIN_PI_VERSION}.
 *
 * Policy:
 * - Version parsed and `>= MIN_PI_VERSION`: returns the version (cached per
 *   command and working directory for this process).
 * - Version parsed and too old: throws {@link PiVersionError} explaining the
 *   `agent_settled` requirement.
 * - The executable runs but `--version` fails, is interrupted, times out, or
 *   prints something unparseable: throws {@link PiVersionError}. An unknown
 *   version must fail explicitly rather than risk a later hang or a falsely
 *   settled ACP turn.
 * - Genuine launch failures (such as a missing or non-executable binary)
 *   return null and defer to the real spawn, which surfaces its more specific
 *   launch error.
 */
export function assertSupportedPiVersion(piCommand: string, cwd: string = process.cwd()): string | null {
  const cacheKey = JSON.stringify([piCommand, cwd])
  const cached = versionCache.get(cacheKey)
  if (cached) return cached

  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(piCommand, ['--version'], {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      shell: shouldUseShellForPiCommand(piCommand)
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOEXEC') return null
    throw new PiVersionError(
      `Could not determine the pi version: \`${piCommand} --version\` could not be checked from ${cwd}: ${String(err)}. ` +
        `pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event).`
    )
  }

  const launchErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (
    launchErrorCode === 'ENOENT' ||
    launchErrorCode === 'EACCES' ||
    launchErrorCode === 'EPERM' ||
    launchErrorCode === 'ENOEXEC'
  ) {
    return null
  }

  const output = String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim()
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error
      ? String(result.error)
      : result.signal
        ? `terminated by signal ${result.signal}`
        : `exited with status ${String(result.status)}`
    throw new PiVersionError(
      `Could not determine the pi version: \`${piCommand} --version\` ${detail}` +
        `${output ? ` after printing ${JSON.stringify(output.slice(0, 120))}` : ''}. ` +
        `pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event) and fails closed on unknown ` +
        `versions instead of risking hangs or premature ACP turn completion.`
    )
  }

  const version = parsePiVersion(output)

  if (!version) {
    throw new PiVersionError(
      `Could not determine the pi version: \`${piCommand} --version\` printed ${JSON.stringify(output.slice(0, 120))}. ` +
        `pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event) and fails closed on unknown ` +
        `versions instead of risking hangs or premature ACP turn completion.`
    )
  }

  if (comparePiVersions(version, MIN_PI_VERSION) < 0) {
    throw new PiVersionError(
      `Unsupported pi version ${version} (command: ${piCommand}). pi-acp requires pi >= ${MIN_PI_VERSION}, which adds ` +
        `the \`agent_settled\` RPC event used to close ACP prompt turns safely. ` +
        `Update pi: \`npm i -g @earendil-works/pi-coding-agent\`.`
    )
  }

  versionCache.set(cacheKey, version)
  return version
}
