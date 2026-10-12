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
  - First reports include the canonical backend tool name when known, separately from the display title (a stable v1 SHOULD, supported but still annotated experimental in SDK 1.4.0)
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
  - `session/close` cancels current owned foreground work and releases the session subprocess while preserving history; previously detached children are not stopped and may outlive close or disconnect
  - `session/delete` idempotently closes and removes a persisted pi session
- Session persistence
  - pi stores its own sessions under its agent directory (normally `~/.pi/agent/sessions/...`)
  - `pi-acp` stores atomic per-session records under `~/.pi/pi-acp/session-map.json.d/` so concurrent adapter processes do not lose each other's mappings. An existing legacy `session-map.json` remains a read-only migration fallback; deletion tombstones prevent legacy entries from reappearing
- Slash commands are advertised from pi's authoritative `get_commands` result, plus a small set of adapter built-ins
- Pi owns project trust, prompt/template expansion, skills, extensions, and resource loading; the adapter does not scan project resources before pi applies trust policy
- Text embedded resources and valid image resources are preserved. Malformed images, audio, and unsupported binary MIME types are rejected before any prompt is sent
- Pi extension select/confirm UI maps to ACP permissions. Input/editor UI maps to stable v1 form elicitation only when the client negotiates it; otherwise pi receives cancellation
  - Native dialog timeouts cancel the ACP request and complete permission cards; late answers are ignored without replying to an expired pi dialog. Explicit answers and cancellation still send the appropriate native response
- Stable context-window/cost updates and unstable SDK prompt-response cumulative token totals are published when pi reports finite values
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
- Terminal login uses stable v1 `clientCapabilities.auth.terminal`; Zed's `_meta["terminal-auth"]` launch banner is a separately negotiated extension.
- Dialog timeout mirroring starts when the adapter receives the pi event, after native transport, so it cannot exactly reproduce the native deadline. Zero and NaN disable native timeouts; finite negative, sub-millisecond, and overflowing Node delays expire at 1 ms, and other finite delays are truncated to integer milliseconds. JSON serializes nonfinite numbers as null: the adapter cannot distinguish a native Infinity timeout (which Node expires) from a disabled/absent timeout. No blanket turn-end UI cancellation is applied; nontimed session-scoped dialogs remain until answered or explicitly cancelled.
- ACP permits session updates outside prompt turns. Autonomous assistant/tool progress is published as session-scoped updates, never as the result or permission request of an unrelated foreground prompt. Idle custom messages without an observed run remain buffered until a prompt or autonomous run starts.
- ACP v1 requires agents to connect client-provided stdio MCP servers, but pi has no MCP support (it would require a pi extension to bridge them). `pi-acp` therefore rejects `session/new`, `session/load`, and `session/resume` requests that carry a non-empty `mcpServers` list with an explicit `invalid params` error instead of silently ignoring the requested servers; empty lists are accepted. This remains an explicit protocol conformance gap. Installing the [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) makes separately configured MCP servers available to pi, but does not wire the ACP request's `mcpServers` automatically.
- ACP fork, steering/follow-up methods, MCP, additional directories, subagent lineage, goals/AIR, interactive terminal stdin, and sandbox/approval modes are not advertised because current pi RPC cannot safely provide those semantics. Adapter `/steering` and `/follow-up` commands only configure pi queue delivery modes.
- On Windows, native executables launch directly. `.cmd`/`.bat` launchers necessarily pass through `cmd.exe`; pi-acp builds an escaped argument boundary and never enables Node's `shell` mode.
- Additional workspace directories are not supported: the `sessionCapabilities.additionalDirectories` capability is not advertised, and `session/new`, `session/load`, and `session/resume` requests carrying a non-empty `additionalDirectories` list are rejected with `invalid params` instead of silently dropping the extra roots. The session's `cwd` remains the only workspace root.
- Pi session files do not coordinate concurrent writers: each pi process keeps its own in-memory view while appending to the shared history. `pi-acp` inherits this constraint, so simultaneously operating on the same persisted session from multiple `pi-acp` or pi processes is unsupported. Atomic adapter mapping records prevent cross-process map updates from being lost, but they are not a session-ownership lease; keep one active writer per persisted session to prevent divergent or damaged history.
- Assistant text streams as `agent_message_chunk`; extended thinking streams separately as `agent_thought_chunk`.
- Foreground prompts share a local FIFO and one Pi subprocess. Native `agent_settled` releases the foreground request, even if a delegated child is still live; its later delivery/synthesis is autonomous session progress. Ordinary input while the model is idle can run without adopting or stopping existing/restored children. While a model run is active, the client sees a locally queued notice plus autonomous progress; native acknowledgement can still be pending behind awaited settlement hooks or earlier deferred synthesis. Existing admission controls are serialized and exact withdrawal invalidates locally without waiting for those hooks. Only native acknowledgement plus observed model settlement/readiness permits raw input delivery. Admission-control response budgets exclude observed unsettled native work and resume after settlement; ordinary RPC, manual work, raw preflight and owned cancellation retain bounded fail-closed deadlines. A healthy run is not killed for exceeding the former ten-minute prompt-admission wait. This does not promise an immediate model answer during a running tool call.
- Staged input is withdrawable by exact token: cancel/close cannot later dispatch it or abort unrelated work. Raw prompts retain native input interception and template expansion but omit the unsafe `streamingBehavior: 'followUp'` fallback: if Pi becomes busy between readiness and dispatch, its preacceptance busy rejection re-stages input without inserting unremovable text into the native queue. Retrying a busy rejection replays native input hooks; a hook that starts work on every attempt can repeatedly prevent delivery. Foreground acceptance/user-message correlation, foreign result/permission isolation, nested-lifecycle quarantine and genuine RPC deadlines remain in force. Cancellation after raw preflight begins still quarantines when no owned run can safely be aborted. Cancellation of an executing foreground stops only its exact observed children, but native global `clear_queue` can discard already queued completion deliveries from detached or restored children as well. Native foreground settlement detaches child cancellation ownership: later prompts, session close, and ACP disconnect do not re-adopt or stop those children, which may outlive the adapter.
- Adapter-handled built-ins (`/compact`, `/name`, ...) still require exclusive model access and share the FIFO, including their bounded admission wait. Pi's `abort` cannot cancel an in-flight manual RPC (compaction, export, ...), so cancelling such work quarantines its channel and restores on the next request. A command with no Pi work in flight is cancelled locally without touching the subprocess.
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)). This project originated from [svkozak/pi-acp](https://github.com/svkozak/pi-acp) and retains its original copyright and license attribution; independently maintained changes are attributed separately.

### Auxiliary manual probes

`npm run smoke` remains an isolated, non-provider initialize/new/builtin/cancel/shutdown check.
After `npm run build`, the other `scripts/smoke-*.mjs` entrypoints are manual probes, not CI coverage.
Use disposable `PI_CODING_AGENT_DIR`, `PI_ACP_DIR`, and `PI_CODING_AGENT_SESSION_DIR` directories.
`smoke-compact.mjs`, `smoke-export.mjs`, and `smoke-acp-load.mjs` can generate provider traffic and require
`PI_ACP_MANUAL_PROVIDER=1` plus configured credentials. All probes assert responses and have finite deadlines.
