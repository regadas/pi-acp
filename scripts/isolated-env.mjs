import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Placeholder provider keys: enough for pi to enumerate models, never real credentials. */
export const SMOKE_CREDENTIAL_PLACEHOLDER = 'pi-acp-smoke-no-call'

/**
 * Runs `run` against freshly created disposable user, adapter, pi-agent and
 * workspace directories, then removes the whole root — also when `run` fails.
 * The returned value (or thrown error) passes through.
 */
export async function withIsolation(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dirs = {
    root,
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    acpDir: join(root, 'pi-acp'),
    agentDir: join(root, 'agent')
  }
  await Promise.all(
    [dirs.home, dirs.workspace, dirs.acpDir, dirs.agentDir, join(dirs.home, '.config')].map(dir =>
      mkdir(dir, { recursive: true })
    )
  )
  try {
    return await run(dirs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Points every user-state location the adapter and pi resolve at the
 * disposable `dirs` instead of the real home — pi's default session directory
 * follows the disposable agent dir — and scrubs inherited launch and session
 * overrides (`PI_ACP_PI_COMMAND`, `PI_ACP_REEXEC`,
 * `PI_CODING_AGENT_SESSION_DIR`) so default resolution is exercised and
 * discovery assertions stay deterministic. Everything else (PATH, NODE_*,
 * ...) passes through unchanged.
 */
export function isolatedEnv(env, dirs) {
  const isolated = {
    ...env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, '.config'),
    PI_ACP_DIR: dirs.acpDir,
    PI_CODING_AGENT_DIR: dirs.agentDir
  }
  delete isolated.PI_ACP_PI_COMMAND
  delete isolated.PI_ACP_REEXEC
  delete isolated.PI_CODING_AGENT_SESSION_DIR
  return isolated
}
