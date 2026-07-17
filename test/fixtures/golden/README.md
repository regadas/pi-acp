# Golden fixtures: Pi NDJSON → ACP session effects

Language-neutral, hand-maintained behavior locks for the pi-acp session translation layer.
Each fixture replays a script of raw Pi RPC events through one adapter session and asserts
the exact observable effects on both sides of the adapter. The TypeScript runner is
`test/component/golden-fixtures.test.ts`; this README is the normative contract, written so
another implementation (for example a Rust port) can consume the same JSON files without
reading the TypeScript runner.

## Boundary

A fixture exercises exactly one adapter session (pi-acp's `PiAcpSession` equivalent): the
component that receives already-parsed Pi RPC stdout events and produces ACP `session/update`
notifications, prompt stop reasons, and pi-bound commands. Stdout NDJSON framing, subprocess
lifecycle, ACP JSON-RPC transport, session persistence, and initialize negotiation are out of
scope and covered by other tests.

Every `pi_event.event` object is a **verbatim Pi NDJSON record**: the JSON object that
`pi --mode rpc` writes as one line on stdout. Fixtures store them as parsed JSON objects in an
array, but their shape is exactly the wire shape, so a different implementation can feed them
through its own event dispatch unchanged.

## File format (`formatVersion: 1`)

One JSON object per file:

| Field                                | Meaning                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `formatVersion`                      | Must be `1`.                                                                                  |
| `name`                               | Test case name (matches the file name by convention).                                         |
| `description`                        | What behavior the case locks.                                                                 |
| `session.sessionId`                  | Session id for the session under test. Always `"s1"` in v1.                                   |
| `session.cwd`                        | Session working directory. Always `"/fixture/cwd"` in v1; it must never be touched on disk.   |
| `session.supportsTerminalOutputMeta` | Optional, default `false`. Enables the negotiated Zed `_meta.terminal_output` bash rendering. |
| `steps`                              | Ordered script (see below).                                                                   |
| `expected.pi`                        | Ordered pi-bound effects.                                                                     |
| `expected.acp`                       | Ordered client-bound effects.                                                                 |

### Steps

| Step                                                   | Semantics                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "op": "prompt", "promptId": "...", "text": "..." }` | Submit an ACP `session/prompt` with the given text. `promptId` is a fixture-local correlation id (it is not a wire field). The runner records the prompt's eventual settlement as a `stop` or `error` effect. |
| `{ "op": "cancel" }`                                   | Invoke ACP `session/cancel` semantics: clear queued prompts and abort the running turn. The runner waits for the cancel call to finish before the next step.                                                  |
| `{ "op": "pi_event", "event": { ... } }`               | Deliver one verbatim Pi NDJSON stdout record to the session.                                                                                                                                                  |

### Effects

`expected.pi` entries (commands the session sends to the pi subprocess):

| Effect                                   | Meaning                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "kind": "prompt", "message": "..." }` | A `prompt` command forwarded to pi (after adapter-side slash-command expansion; v1 fixtures avoid slash commands so the text is unchanged). Queued prompts that get cancelled before starting are never forwarded. |
| `{ "kind": "abort" }`                    | An `abort` command sent to pi.                                                                                                                                                                                     |

`expected.acp` entries (effects observable by the ACP client):

| Effect                                                                                           | Meaning                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "kind": "session_update", "update": { ... } }`                                                | One `session/update` notification payload. The notification's `sessionId` always equals `session.sessionId` and is asserted separately, so it is not repeated per entry. |
| `{ "kind": "stop", "promptId": "...", "stopReason": "end_turn" \| "max_tokens" \| "cancelled" }` | The prompt identified by `promptId` resolved with that ACP stop reason.                                                                                                  |
| `{ "kind": "error", "promptId": "...", "message": "..." }`                                       | The prompt rejected; `message` is the stringified error. (Reserved: no v1 fixture uses it.)                                                                              |

## Execution contract

1. Create one session with `sessionId`, `cwd`, `supportsTerminalOutputMeta` (default false),
   no MCP servers, and no file slash commands. The pi side is a stub that acknowledges
   `prompt`/`abort` immediately and reports agent state `isStreaming: true` when probed after
   prompt acceptance (so accepted prompts stay open until `agent_settled`).
2. Execute steps strictly in order. After **every** step, drain the runtime to quiescence
   (Node: one `setTimeout(0)` macrotask boundary, which flushes all pending microtasks; Rust:
   run the executor until no fixture-driven task can make progress). Perform one final drain
   after the last step.
3. Record effects as they become observable:
   - a pi effect when the session invokes the pi command;
   - a `session_update` effect when the notification is delivered to the client connection;
   - a `stop`/`error` effect when the prompt's returned promise/future settlement is observed.
4. Every prompt must have settled by the end of the run; otherwise the case fails
   ("prompt never settled") rather than hanging.

### Ordering

Ordering is normative **within each channel only** (`expected.pi` and `expected.acp` are each
ordered; nothing is implied about interleaving between the two channels). Within the `acp`
channel the fixtures lock, among others, these invariants:

- Every turn-bound update of a prompt (message/thought chunks, tool calls, retry and
  compaction notices) is delivered before that prompt's `stop` entry.
- A prompt settlement becomes observable only after every session update already enqueued for
  delivery — **including the trailing queue-status update its own completion enqueues**. A
  turn's `stop` therefore sorts after that turn's trailing
  `session_info_update {running: false}`. This mirrors the wire, where the notification is
  written before the `session/prompt` response.
- `cancel` settles queued (never-started) prompts right after the updates that explain the
  queue clearing; the running prompt settles only at `agent_settled`.
- Only `agent_settled` settles a prompt. `turn_end` and `agent_end` never do.

## Comparison

Comparison is **structural JSON equality per channel**: parse `expected.pi`/`expected.acp` and
compare against the recorded effect lists as JSON values (object key order is irrelevant;
array order is significant). The TypeScript runner JSON-round-trips the recorded effects
before comparing so fields set to `undefined` compare as absent; any other implementation must
likewise compare only fields that would survive JSON serialization (Rust: compare
`serde_json::Value`).

## Determinism and authoring rules

- Fixed `sessionId` (`s1`) and fixed `cwd` (`/fixture/cwd`). The cwd appears verbatim in
  negotiated bash `terminal_info` metadata and must not be resolved against the real
  filesystem.
- Deterministic `toolCallId`s supplied by the input events (`t1`, ...).
- No filesystem-dependent tool arguments: never use `path`/`file_path` args (they trigger
  filesystem checks for tool locations, edit line numbers, and diffs). Bash `{ "command": ... }`
  and generic args like `{ "query": ... }` are safe.
- No timestamps, UUIDs, random values, environment variables, or placeholder expansion of any
  kind. Files are plain JSON data.
- Fixtures intentionally freeze user-visible adapter strings (retry notices, queue notices,
  fenced console blocks). Copy changes in the adapter are supposed to break fixtures; update
  the fixture deliberately when the new copy is intended.

## No auto-update / blessing

`expected` arrays are hand-derived from intended behavior (existing unit/component test
assertions and the session/translation source), then verified by running the case. There is no
snapshot-update mode. If a run disagrees with a hand-derived expectation and the difference is
not a fixture authoring mistake, treat it as a potential adapter regression: investigate and
report it — do not copy the observed output into the fixture.

## Adding a fixture

1. Create `test/fixtures/golden/<name>.json` with `formatVersion: 1`, a unique `name`
   (conventionally the file name), a one-sentence `description`, and the fixed session values
   above.
2. Write the `steps` script using verbatim Pi NDJSON event objects. Wrap event sequences in a
   `prompt` … `agent_settled` turn so the case does not depend on out-of-turn delivery policy.
3. Hand-derive `expected.pi` and `expected.acp` from the intended behavior before running.
4. Run `node --import tsx --test test/component/golden-fixtures.test.ts` and reconcile any
   difference per the no-blessing rule, then run `npm run format`.
