# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

This repository is independently maintained by [Filipe Regadas](https://github.com/regadas). It originated from [svkozak/pi-acp](https://github.com/svkozak/pi-acp) and preserves that project's Git history and MIT attribution, but it is not affiliated with the upstream project or its unscoped `pi-acp` npm package. The intended npm identity for a future release is `@regadas/pi-acp`; it is not currently published.

## Status

`pi-acp` targets the stable ACP v1 core using the current `@agentclientprotocol/sdk` builder API. It implements the baseline prompt lifecycle plus stable session list, load, resume, close, and delete methods. It is not fully ACP v1 conformant because client-provided stdio MCP servers are not supported: pi itself has no MCP support, so requests with a non-empty `mcpServers` list are rejected explicitly instead of being silently ignored; see [Limitations](#limitations).

Development is centered around [Zed](https://zed.dev) editor support, and other clients may have varying levels of compatibility. Expect some minor breaking changes.

## Features

- Streams assistant text as ACP `agent_message_chunk` and extended thinking as `agent_thought_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Bash output uses Zed's negotiated `_meta.terminal_output` display convention when the client advertises it (`clientCapabilities._meta.terminal_output: true`); other clients receive the output as standard text content, so nothing is lost
  - Tool-result image content is preserved as ACP image content
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Stable ACP v1 session lifecycle
  - `session/list` discovers all known pi sessions or filters them by cwd
  - `session/load` restores a session and replays the complete active-branch history (via pi's `get_tree`) before responding: user text and images, assistant text, thinking, and tool calls, tool results, visible custom messages, and `!command` shell executions, including pre-compaction history
  - `session/resume` restores a session without replaying history
  - Model and thinking-level selection go through standard ACP session config options (`session/set_config_option`); advertised thinking levels mirror exactly what the selected pi model supports (including pi's `max` level). Legacy ACP session modes are not used: no session response advertises `modes`, and `session/set_mode` is not implemented
  - `session/close` cancels live work and releases the session subprocess while preserving history
  - `session/delete` idempotently closes and removes a persisted pi session
- Session persistence
  - pi stores its own sessions under its agent directory (normally `~/.pi/agent/sessions/...`)
  - `pi-acp` stores atomic per-session records under `~/.pi/pi-acp/session-map.json.d/` so concurrent adapter processes do not lose each other's mappings. An existing legacy `session-map.json` remains a read-only migration fallback; deletion tombstones prevent legacy entries from reappearing
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js >= 22.19.0
- `pi` installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

This independently maintained version is not currently published in the ACP Registry or on npm. The Registry entry and unscoped `pi-acp` npm package install the upstream project, not this repository.

### From source

```bash
git clone https://github.com/regadas/pi-acp.git
cd pi-acp
npm ci
npm run build
```

To expose the existing `pi-acp` executable on your `PATH`, link the package:

```bash
npm link
```

Then configure a custom agent in [Zed](https://zed.dev/docs/agents/external-agents/):

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Alternatively, point Zed directly to the built entry point without linking it:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
}
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- `PI_ACP_DIR=/path/to/state` overrides the adapter-owned state directory (default: `~/.pi/pi-acp`).
- `PI_CODING_AGENT_DIR=/path/to/agent` overrides pi's global agent directory for settings, sessions, prompts, extensions, and skills (default: `~/.pi/agent`).
- Default for `PI_ACP_ENABLE_EMBEDDED_CONTEXT`: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `<PI_CODING_AGENT_DIR>/prompts/**/*.md` (normally `~/.pi/agent/prompts/**/*.md`)
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to the thinking (`thought_level`) config option selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Authentication (ACP client support)

This agent supports **Terminal Auth** for ACP clients that negotiate it.
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run typecheck
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally. Bash tool calls are rendered through Zed's `_meta.terminal_output` convention only when the client negotiates it; otherwise output is plain tool content.
- Terminal login is advertised only to clients that declare the (unstable) `clientCapabilities.auth.terminal` capability; Zed's `_meta["terminal-auth"]` launch banner additionally requires its matching client `_meta` flag.
- ACP v1 requires agents to connect client-provided stdio MCP servers, but pi has no MCP support (it would require a pi extension to bridge them). `pi-acp` therefore rejects `session/new`, `session/load`, and `session/resume` requests that carry a non-empty `mcpServers` list with an explicit `invalid params` error instead of silently ignoring the requested servers; empty lists are accepted. This remains an explicit protocol conformance gap. Installing the [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) makes separately configured MCP servers available to pi, but does not wire the ACP request's `mcpServers` automatically.
- Additional workspace directories are not supported: the `sessionCapabilities.additionalDirectories` capability is not advertised, and `session/new`, `session/load`, and `session/resume` requests carrying a non-empty `additionalDirectories` list are rejected with `invalid params` instead of silently dropping the extra roots. The session's `cwd` remains the only workspace root.
- Pi session files do not coordinate concurrent writers: each pi process keeps its own in-memory view while appending to the shared history. `pi-acp` inherits this constraint, so simultaneously operating on the same persisted session from multiple `pi-acp` or pi processes is unsupported. Atomic adapter mapping records prevent cross-process map updates from being lost, but they are not a session-ownership lease; keep one active writer per persisted session to prevent divergent or damaged history.
- Assistant text streams as `agent_message_chunk`; extended thinking streams separately as `agent_thought_chunk`.
- Prompt queueing is a local FIFO in the adapter (one pi prompt at a time, like pi's `one-at-a-time`). Because pi extensions can start their own runs, dispatch waits for observed out-of-band pi activity to settle and fails closed if that admission wait expires. Every prompt also carries pi's non-interrupting `streamingBehavior: 'followUp'` so an unobserved dispatch race is queued by pi instead of rejected; pi output remains unowned until the prompt's response or queued user-message boundary. Ambiguous nested run lifecycles are quarantined rather than attributed to the wrong ACP turn. If an extension command starts and finishes a run before pi acknowledges the command prompt, that run's turn-bound stream is suppressed because Pi RPC exposes no correlation ID.
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)). This project originated from [svkozak/pi-acp](https://github.com/svkozak/pi-acp) and retains its original copyright and license attribution; independently maintained changes are attributed separately.
