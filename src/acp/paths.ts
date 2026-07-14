import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 * PI_ACP_DIR overrides the location (mirrors pi's PI_CODING_AGENT_DIR).
 */
export function getPiAcpDir(): string {
  return process.env.PI_ACP_DIR ? resolve(process.env.PI_ACP_DIR) : join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}
