import type { AuthMethod } from '@agentclientprotocol/sdk/unstable'

export const PI_SETUP_METHOD_ID = 'pi_terminal_login'

/**
 * Terminal login methods for the negotiating client:
 *  - The stable v1 terminal AuthMethod (`type`/`args`/`env`) is advertised
 *    only when the client declared `clientCapabilities.auth.terminal`.
 *  - The optional `_meta["terminal-auth"]` launch spec is included only when
 *    the client also declared
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

  const method: AuthMethod & {
    type: 'terminal'
    args: string[]
    env: Record<string, string>
  } = {
    id: PI_SETUP_METHOD_ID,
    name: 'Launch pi in the terminal',
    description: 'Start pi in an interactive terminal to configure API keys or login',

    type: 'terminal',
    args: ['--terminal-login'],
    env: {}
  }

  if (supportsTerminalAuthMeta) {
    // The negotiated launch spec includes the full command and arguments.
    const launch = terminalAuthLaunchSpec()

    method._meta = {
      ...(method._meta ?? {}),
      'terminal-auth': {
        ...launch,
        label: 'Launch pi'
      }
    }
  }

  return [method]
}

/**
 * The launch spec advertised via `_meta["terminal-auth"]`: reuse the actual
 * runtime + entry launch (`node|bun /path/to/dist/index.js`), including after
 * the entry re-exec'd itself under Bun. Anything else falls back to `pi-acp`
 * on PATH.
 */
export function terminalAuthLaunchSpec(argv: readonly string[] = process.argv): { command: string; args: string[] } {
  const argv0 = argv[0] || 'node'
  const argv1 = argv[1]
  if (argv1 && argv0) {
    // Plain runtime binaries only (`node`, `nodejs`, `bun`, optionally
    // version-suffixed like `node-22`): arbitrary names merely containing
    // "node" (e.g. `envnode`) must not advertise themselves as the runtime.
    const basename = argv0.split(/[\\/]/).pop() ?? argv0
    const isRuntime = /^(node|nodejs|bun)([-.\d]*)?(\.exe)?$/i.test(basename)
    const isJs = argv1.endsWith('.js')
    if (isRuntime && isJs) {
      return { command: argv0, args: [argv1, '--terminal-login'] }
    }
  }

  // Fallback: assume `pi-acp` is on PATH.
  return { command: 'pi-acp', args: ['--terminal-login'] }
}
