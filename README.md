# pi-acp

`pi-acp` connects the [`pi`](https://github.com/earendil-works/pi) coding agent to clients that support the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction).

It translates ACP JSON-RPC 2.0 messages over stdio into commands for `pi --mode rpc`. It then streams pi events back to the client.

`pi-acp` is an independent fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp). It retains the original project's Git history and MIT attribution.

The project is separate from the original repository and the unscoped `pi-acp` npm package. Future releases will use the scoped package name `@regadas/pi-acp`. The package is not published yet.

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
  - `session/load` restores a session and replays the complete active-branch history (via pi's `get_entries`) before responding: user text and images, assistant text, thinking, and tool calls, tool results, visible custom messages, and `!command` shell executions, including pre-compaction history
  - `session/resume` restores a session without replaying history
  - Model and thinking-level selection go through standard ACP session config options (`session/set_config_option`); available thinking levels come from pi's RPC API, with a model-metadata fallback only for pi 0.80.x. Legacy ACP session modes are not used
  - `session/close` cancels live work and releases the session subprocess while preserving history
  - `session/delete` idempotently closes and removes a persisted pi session
- Session persistence
  - pi stores its own sessions under its agent directory (normally `~/.pi/agent/sessions/...`)
  - `pi-acp` stores atomic per-session records under `~/.pi/pi-acp/session-map.json.d/` so concurrent adapter processes do not lose each other's mappings. An existing legacy `session-map.json` remains a read-only migration fallback; deletion tombstones prevent legacy entries from reappearing
- Slash commands are advertised from pi's authoritative `get_commands` result, plus a small set of adapter built-ins
- Pi owns project trust, prompt/template expansion, skills, extensions, and resource loading; the adapter does not scan project resources before pi applies trust policy
- Text embedded resources and valid image resources are preserved. Malformed images, audio, and unsupported binary MIME types are rejected before any prompt is sent
- Pi extension select/confirm UI maps to ACP permissions. Input/editor UI maps to unstable form elicitation only when the client negotiates it; otherwise pi receives cancellation
- Prompt responses publish cumulative token usage and context-window/cost updates when pi reports finite values
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js >= 22.19.0
- pi >= 0.80.4 installed and available on your `PATH` (the adapter runs the `pi` executable)
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

- `PI_ACP_DIR=/path/to/state` overrides the adapter-owned state directory (default: `~/.pi/pi-acp`).
- `PI_CODING_AGENT_DIR=/path/to/agent` overrides pi's global agent directory for settings, sessions, prompts, extensions, and skills (default: `~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` selects pi's custom session directory. Otherwise merged global/project `sessionDir` settings apply, then pi's cwd-encoded default. `~` expands and relative custom paths resolve from the session cwd.

### Slash commands

`pi-acp` supports slash commands:

Pi discovers and expands file prompts, skills, and extension commands after applying its own project trust policy. `pi-acp` advertises the resulting command list without reading prompt files itself.

#### Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - maps to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to the thinking (`thought_level`) config option selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

Pi-provided skill and extension commands appear when pi includes them in `get_commands`.

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
- ACP fork, steering/follow-up methods, MCP, additional directories, subagent lineage, goals/AIR, interactive terminal stdin, and sandbox/approval modes are not advertised because current pi RPC cannot safely provide those semantics. Adapter `/steering` and `/follow-up` commands only configure pi queue delivery modes.
- On Windows, native executables launch directly. `.cmd`/`.bat` launchers necessarily pass through `cmd.exe`; pi-acp builds an escaped argument boundary and never enables Node's `shell` mode.
- Additional workspace directories are not supported: the `sessionCapabilities.additionalDirectories` capability is not advertised, and `session/new`, `session/load`, and `session/resume` requests carrying a non-empty `additionalDirectories` list are rejected with `invalid params` instead of silently dropping the extra roots. The session's `cwd` remains the only workspace root.
- Pi session files do not coordinate concurrent writers: each pi process keeps its own in-memory view while appending to the shared history. `pi-acp` inherits this constraint, so simultaneously operating on the same persisted session from multiple `pi-acp` or pi processes is unsupported. Atomic adapter mapping records prevent cross-process map updates from being lost, but they are not a session-ownership lease; keep one active writer per persisted session to prevent divergent or damaged history.
- Assistant text streams as `agent_message_chunk`; extended thinking streams separately as `agent_thought_chunk`.
- Prompt queueing is a local FIFO in the adapter (one pi prompt at a time, like pi's `one-at-a-time`). Because pi extensions can start their own runs, dispatch waits for observed out-of-band pi activity to settle and fails closed if that admission wait expires. Every prompt also carries pi's non-interrupting `streamingBehavior: 'followUp'` so an unobserved dispatch race is queued by pi instead of rejected; pi output remains unowned until the prompt's response or queued user-message boundary. Ambiguous nested run lifecycles are quarantined rather than attributed to the wrong ACP turn. If an extension command starts and finishes a run before pi acknowledges the command prompt, that run's turn-bound stream is suppressed because Pi RPC exposes no correlation ID. Adapter-handled built-in commands (`/compact`, `/name`, ...) share the same FIFO: they wait for an active prompt and hold later prompts back while they run. pi's `abort` stops an agent run but cannot cancel an in-flight manual RPC (compaction, export, ...), so `session/cancel` fails closed instead: a command still waiting on pi has its channel quarantined, the request settles as `cancelled` with no partial result reported, and the next request restores the session on a fresh pi subprocess. A command with no pi work in flight is settled locally and leaves the subprocess untouched.
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)). This project originated from [svkozak/pi-acp](https://github.com/svkozak/pi-acp) and retains its original copyright and license attribution; independently maintained changes are attributed separately.
