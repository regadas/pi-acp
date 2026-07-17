import type { AuthMethod } from '@agentclientprotocol/sdk'

export const PI_SETUP_METHOD_ID = 'pi_terminal_login'

/**
 * Terminal login methods for the negotiating client:
 *  - The SDK's unstable terminal AuthMethod (`type`/`args`/`env`) is advertised
 *    only when the client declared `clientCapabilities.auth.terminal`.
 *  - Zed additionally reads `_meta["terminal-auth"]` (launch spec) to render
 *    its "Authenticate" banner; included only when the client also declared
 *    the matching `clientCapabilities._meta["terminal-auth"]` flag.
 * A client that does not declare the standard terminal auth capability gets
 * no auth methods: pi-acp has no agent-managed auth flow, so advertising one
 * would dead-end the user. There is no module-level negotiation state: each
 * `PiAcpAgent` computes its advertised methods at `initialize` and threads
 * them through auth-required error mapping.
 */
export function getAuthMethods(opts?: {
  supportsTerminalAuth?: boolean
  supportsTerminalAuthMeta?: boolean
}): AuthMethod[] {
  const supportsTerminalAuth = opts?.supportsTerminalAuth ?? false
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? false

  if (!supportsTerminalAuth) return []

  const method: any = {
    id: PI_SETUP_METHOD_ID,
    name: 'Launch pi in the terminal',
    description: 'Start pi in an interactive terminal to configure API keys or login',

    type: 'terminal',
    args: ['--terminal-login'],
    env: {}
  }

  if (supportsTerminalAuthMeta) {
    // Best-effort launch spec for Zed's terminal-auth banner.
    // Zed expects a full command+args (see mistral-vibe implementation).
    const launch = terminalAuthLaunchSpec()

    method._meta = {
      ...(method._meta ?? {}),
      'terminal-auth': {
        ...launch,
        label: 'Launch pi'
      }
    }
  }

  return [method as AuthMethod]
}

function terminalAuthLaunchSpec(): { command: string; args: string[] } {
  // If we were launched as `node /path/to/dist/index.js`, reuse that.
  // This is the most reliable in local dev and custom Zed configurations.
  const argv0 = process.argv[0] || 'node'
  const argv1 = process.argv[1]
  if (argv1 && argv0) {
    const isNode = argv0.includes('node')
    const isJs = argv1.endsWith('.js')
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, '--terminal-login'] }
    }
  }

  // Fallback: assume `pi-acp` is on PATH.
  return { command: 'pi-acp', args: ['--terminal-login'] }
}
