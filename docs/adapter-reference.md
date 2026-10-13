# Adapter reference

Detailed protocol behavior, configuration, and compatibility limits for `pi-acp`.
For installation and a quick overview, start with the [README](../README.md).

## Status

`pi-acp` targets the stable ACP v1 core using the current `@agentclientprotocol/sdk` builder API. It implements the baseline prompt lifecycle plus stable session list, load, resume, close, and delete methods. It is not fully ACP v1 conformant because client-provided stdio MCP servers are not supported: pi itself has no MCP support, so requests with a non-empty `mcpServers` list are rejected explicitly instead of being silently ignored; see [Limitations](#limitations).

The design targets ACP clients generically. Optional extensions are enabled only by negotiated capabilities, never by client identity; standard ACP content remains the fallback. [Zed](https://zed.dev) is a compatibility benchmark, not the design target. Client support may vary; expect some minor breaking changes.

## Features

- Streams assistant text as ACP `agent_message_chunk` and extended thinking as `agent_thought_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - First reports include the canonical backend tool name when known, separately from the display title (a stable v1 SHOULD, supported but still annotated experimental in SDK 1.4.0)
  - Bash output uses the negotiated `_meta.terminal_output` display extension when the client advertises it (`clientCapabilities._meta.terminal_output: true`); other clients receive the output as standard text content, so nothing is lost
  - Tool-result image content is preserved as ACP image content
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables client follow-along features
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

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js >= 22.19.0
- Optional: `bun` on your `PATH`. When it is available, the adapter replaces its Node process in place with `execve` (the client keeps the PID, stdio and signal handling it launched), and default direct-JavaScript `pi` installs (npm symlinks to a Node- or Bun-shebang `.js` entry) also run under Bun. It stays on Node when `bun` is missing or `process.execve` is unavailable; an `execve` failure itself (e.g. an unusable `bun` binary) aborts the launch instead of falling back to Node, and a `bun` that starts but crashes is not retried on Node. Explicit `PI_ACP_PI_COMMAND` overrides, shell launchers (including the managed `~/.pi/agent/bin/pi`), standalone binaries, interpreter-flag or unrecognized shebang entries, and Windows always launch unchanged
- pi >= 1.1.0 installed and available on your `PATH` (the adapter runs the `pi` executable). The async-subagent completion integration is tested only against Pi 1.1.0 with the `nicobailon/pi-subagents` git-main checkout at `29284cd943c0c7ee852593c6e02d2a60febf6ba4` (entry `./index.ts`); other pi-subagents versions are not claimed compatible. Completion notices without structured run IDs are rejected with an explicit error
- Configure `pi` separately for your model providers/API keys

## Environment variables

- `PI_ACP_DIR=/path/to/state` overrides the adapter-owned state directory (default: `~/.pi/pi-acp`).
- `PI_CODING_AGENT_DIR=/path/to/agent` overrides pi's global agent directory for settings, sessions, prompts, extensions, and skills (default: `~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` selects pi's custom session directory. Otherwise merged global/project `sessionDir` settings apply, then pi's cwd-encoded default. `~` expands and relative custom paths resolve from the session cwd.

## Slash commands

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

- `/model` - maps to the standard ACP `model` session config option
- `/thinking` - maps to the standard ACP `thought_level` session config option
- `/clear` - not implemented (use ACP client 'new' command)

Pi-provided skill and extension commands appear when pi includes them in `get_commands`.

## Authentication (ACP client support)

This agent supports **Terminal Auth** when the client advertises `clientCapabilities.auth.terminal: true`. The optional `_meta["terminal-auth"]` launch specification is included only when the client also negotiates that extension. Rendering and launch UI are client-owned.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally. Bash tool calls use the `_meta.terminal_output` display extension only when the client negotiates it; otherwise output is plain tool content.
- Terminal login uses stable v1 `clientCapabilities.auth.terminal`; the `_meta["terminal-auth"]` launch specification is a separately negotiated extension.
- Dialog timeout mirroring starts when the adapter receives the pi event, after native transport, so it cannot exactly reproduce the native deadline. Zero and NaN disable native timeouts; finite negative, sub-millisecond, and overflowing Node delays expire at 1 ms, and other finite delays are truncated to integer milliseconds. JSON serializes nonfinite numbers as null: the adapter cannot distinguish a native Infinity timeout (which Node expires) from a disabled/absent timeout. No blanket turn-end UI cancellation is applied; nontimed session-scoped dialogs remain until answered or explicitly cancelled.
- ACP permits session updates outside prompt turns. Autonomous assistant/tool progress is published as session-scoped updates, never as the result or permission request of an unrelated foreground prompt. Idle custom messages without an observed run remain buffered until a prompt or autonomous run starts.
- ACP v1 requires agents to connect client-provided stdio MCP servers, but pi has no MCP support (it would require a pi extension to bridge them). `pi-acp` therefore rejects `session/new`, `session/load`, and `session/resume` requests that carry a non-empty `mcpServers` list with an explicit `invalid params` error instead of silently ignoring the requested servers; empty lists are accepted. This remains an explicit protocol conformance gap. Installing the [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) makes separately configured MCP servers available to pi, but does not wire the ACP request's `mcpServers` automatically.
- ACP fork, steering/follow-up methods, MCP, additional directories, subagent lineage, goals/AIR, interactive terminal stdin, and sandbox/approval modes are not advertised because current pi RPC cannot safely provide those semantics. Adapter `/steering` and `/follow-up` commands only configure pi queue delivery modes.
- On Windows, native executables launch directly. `.cmd`/`.bat` launchers necessarily pass through `cmd.exe`; pi-acp builds an escaped argument boundary and never enables Node's `shell` mode.
- Additional workspace directories are not supported: the `sessionCapabilities.additionalDirectories` capability is not advertised, and `session/new`, `session/load`, and `session/resume` requests carrying a non-empty `additionalDirectories` list are rejected with `invalid params` instead of silently dropping the extra roots. The session's `cwd` remains the only workspace root.
- Pi session files do not coordinate concurrent writers: each pi process keeps its own in-memory view while appending to the shared history. `pi-acp` inherits this constraint, so simultaneously operating on the same persisted session from multiple `pi-acp` or pi processes is unsupported. Atomic adapter mapping records prevent cross-process map updates from being lost, but they are not a session-ownership lease; keep one active writer per persisted session to prevent divergent or damaged history.
- Assistant text streams as `agent_message_chunk`; extended thinking streams separately as `agent_thought_chunk`.
- Foreground prompts share a local FIFO and one Pi subprocess. The adapter adds nothing to the system prompt: it does not append or replace system-prompt content, and user/project resources such as `APPEND_SYSTEM.md` reach the model unchanged. Async subagent runs launched or revived for the current request are required by default, which costs interactivity: the request, and the FIFO behind it, stays busy until that work and its delivery finish. Whether a model keeps work asynchronous or asks to detach it is up to the model; only the `acp_detach` tool description and the waiting drafts describe the behavior, and model intent and answer quality are not measured. There is no notification service for detached jobs; a detached job's result appears only if the stock runner delivers it later. The adapter holds the foreground request open across a pre-settlement barrier until every required run is proven terminal in a bounded status snapshot, its structured completion notice is consumed, and a later provider cycle completes. While a terminal run's delivery is pending the model receives runnable waiting drafts at a bounded cadence (at most one per second, up to thirty), which may add provider calls and latency to the request. A proven-terminal run whose notice is not consumed within thirty seconds of ACP waiting fails the request with an explicit error instead of returning success. ACP waiting is only the time the adapter's pre-settlement barrier spends holding the request. Provider requests (including time to first token), tool execution, probe continuations and other extensions' awaited hooks do not count, because Pi cannot consume a queued notice during them. A slow model or tool is therefore neither a delivery failure nor an overall request time limit. Live runs reported by a captured run's completion notice are required too and owe their own notice; a whitespace-padded `resume` and a validated recovered-steering receipt's fresh `replacementRunId` are captured like launches. When a required run that is still working asks its parent through the native pi-subagents supervisor channel, the barrier grants bounded continuations for that exact request (sharing the one-per-second cadence, at most thirty within thirty seconds of ACP waiting after the request); consuming the request closes that window while the child keeps running, and an unconsumed request fails the request visibly. Foreign or detached work never opens such a window. A git-main async workflow can finish dispatch while a child launched with explicit `async: true` keeps running. The child is mapped by its exact run ID and workflow key from the dispatch notice, its terminal state is proven from its own row or from the uniquely keyed step it folds into, and only the child's own native completion notice counts as delivery, followed by a later provider cycle. Status queries, `bg_wait` results and control replies never count as delivery and never create ownership. Delivery proof means the notice reached the model before its final response; it says nothing about whether the answer is correct. Explicitly background work is opt-in through the `acp_detach` tool with the exact run IDs: detached runs keep running and this request neither waits for nor cancels them. Ordinary input while the model is idle can run without adopting or stopping existing/restored children. While a model run is active, the client sees a locally queued notice plus autonomous progress; native acknowledgement can still be pending behind awaited settlement hooks or earlier deferred synthesis. Existing admission controls are serialized and exact withdrawal invalidates locally without waiting for those hooks. Only native acknowledgement plus observed model settlement/readiness permits raw input delivery. Admission-control response budgets exclude observed unsettled native work and resume after settlement; ordinary RPC, manual work, raw preflight and owned cancellation retain bounded fail-closed deadlines. A healthy run is not killed for exceeding the former ten-minute prompt-admission wait. This does not promise an immediate model answer during a running tool call.
- Staged input is withdrawable by exact token: cancel/close cannot later dispatch it or abort unrelated work. Raw prompts retain native input interception and template expansion but omit the unsafe `streamingBehavior: 'followUp'` fallback: if Pi becomes busy between readiness and dispatch, its preacceptance busy rejection re-stages input without inserting unremovable text into the native queue. Retrying a busy rejection replays native input hooks; a hook that starts work on every attempt can repeatedly prevent delivery. Foreground acceptance/user-message correlation, foreign result/permission isolation, nested-lifecycle quarantine and genuine RPC deadlines remain in force. Cancellation after raw preflight begins still quarantines when no owned run can safely be aborted. Cancellation of an executing foreground stops only its exact required roots and proven descendants, but native global `clear_queue` can discard already queued completion deliveries from detached or restored children as well. Detached or foreign work never acquires new stop authority: later prompts, session close, and ACP disconnect do not adopt or stop those children, which may outlive the adapter. Unstructured completion notices, omitted or ambiguous status snapshots, and reused run IDs without consumed delivery attribution fail the owning request visibly instead of counting as quiescence. Such scoped completion failures reject only the owning request and keep the Pi channel: requests already queued behind the failed turn are rejected by the existing FIFO failure policy, while newly submitted requests run on the same channel. Control and cancellation failures (unconfirmed termination, rejected stop/interrupt controls) quarantine the channel and restore it on the next request.
- Adapter-handled built-ins (`/compact`, `/name`, ...) still require exclusive model access and share the FIFO, including their bounded admission wait. Pi's `abort` cannot cancel an in-flight manual RPC (compaction, export, ...), so cancelling such work quarantines its channel and restores on the next request. A command with no Pi work in flight is cancelled locally without touching the subprocess.

## Auxiliary manual probes

`npm run smoke` remains an isolated, non-provider initialize/new/builtin/cancel/shutdown check.
After `npm run build`, the other `scripts/smoke-*.mjs` entrypoints are manual probes, not CI coverage.
Use disposable `PI_CODING_AGENT_DIR`, `PI_ACP_DIR`, and `PI_CODING_AGENT_SESSION_DIR` directories.
`smoke-compact.mjs`, `smoke-export.mjs`, and `smoke-acp-load.mjs` can generate provider traffic and require
`PI_ACP_MANUAL_PROVIDER=1` plus configured credentials. All probes assert responses and have finite deadlines.
