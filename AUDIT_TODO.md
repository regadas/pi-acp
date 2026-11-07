# Audit TODO

Whole-repo ponytail-audit loop — CONVERGED. Four full audit rounds (three
fresh seats each) plus one final blockers-only verification; five fix passes.
Final verdict: OK (no P0/P1 remain). Validation green: 1266 tests / 1263 pass
/ 0 fail / 3 Windows-only skips; typecheck, lint, prettier, build clean; full
suite independently re-run by the parent after every pass. Nothing committed.
Remaining items are deferred-by-decision or documented approximations below.

## P1 — fixed in pass 1

- [x] POSIX launches never tree-kill: only Windows wrappers got `killTree`, so a POSIX wrapper's pi descendant could survive disposal and double-open a session file (`src/pi-rpc/process.ts`, `src/pi-rpc/version.ts`, new `killPosixProcessGroup` + tests)
- [x] stdin `ReadableStream` in the entrypoint had no `cancel()`; SDK-side cancellation could crash or hang the adapter (`src/main.ts`, new `test/unit/entry-runtime.test.ts`)
- [x] v2 replay window dropped buffered replay state before validation; a rejected resume could erase a valid resume's final entry (`src/acp/v2/client.ts`, supersede-time reset)
- [x] `join()`/`resolve()` collapsed `symlink/..` textually, storing sessions and reading settings in the wrong directory (three sites, shared `raw-path.ts` helper + regression tests)
- [x] generic bash coalescing formatted + stringified content it then discarded on every streaming update (`src/acp/session.ts`, measure-before-format)
- [x] `fileSnapshot` allocated a fixed 1 MiB buffer per read (`src/acp/file-snapshot.ts`)
- [x] session list read headers and projects sequentially (`src/acp/session-repository.ts`, bounded batches of 16)
- [x] version-probe cache keyed by cwd; every new workspace re-spawned `pi --version` (`src/pi-rpc/version.ts`, executable-identity key)
- [x] per-session tracking maps never cleaned; `metadataScans` uncapped (`src/acp/agent.ts`, settled-session cleanup; cap 256)
- [x] ~~`scanMetadata` parses every JSONL line~~ **rejected in fix-1**: premise false — every pi record type carries a top-level `timestamp` that `anyTimestamp` legitimately reads, and tool results live inside `message` entries; a type pre-filter would change `updatedAt` semantics and save ~0%

## P2 — fixed in pass 2

Performance:

- [x] rolling bash window re-splits the full text on every streaming update (`src/acp/translate/bash.ts`, newline scan from offset; 200k-case differential check vs old semantics)
- [x] `countOutputLines` built an array just to count newlines (`src/acp/translate/bash.ts`)
- [x] line decoder byte-counted and joined per line; whole lines in one chunk now take a fast path (`src/pi-rpc/line-decoder.ts`)
- [x] `SessionStore.list` reads record files one by one (`src/acp/session-store.ts`, bounded concurrent batches)
- [x] ~~`list()` re-reads store records it already has in memory~~ **rejected in fix-2**: the per-session `store.get()` is the deterministic seam where a concurrent delete is observed mid-list; removing it broke two pass-1 tests — the fresh read is load-bearing
- [x] `dispatchEvent` copied the handler array on every event (`src/pi-rpc/process.ts`, copy-free index loop)
- [x] `customMessageIdentity` stringified full base64 image payloads (`src/acp/session.ts`, mime + sha256 digest)

Lean:

- [x] builtin commands: 19 hand-written copies of the reply block; `/steering` and `/follow-up` near-copies (`src/acp/builtin-commands.ts`, `say()` + one mode table; text byte-identical)
- [x] three copies of track/wait bookkeeping (`src/acp/agent.ts`, one `track()` + one `waitForActive()`)
- [x] dead `done`/`error` `message_update` branches + `auto_compaction_*` legacy cases (verified against pi 1.2.0's published dist: never sent as `message_update`; one stop-reason rule remains; tests migrated)
- [x] production code shaped for test fakes: opts/`SessionCreateParams` index signatures removed (~100 test sites cleaned), store constructor-injected (~35 sites), `typeof` guards deleted, test-only `stderrTail()` removed
- [x] spawn error mapped to `internalError` twice, differently (`src/acp/session-manager.ts`, mapped once in `spawnOwned`)
- [x] `runPromptWithCancellation` duplicated `agent.prompt`'s cancellation (wrapper deleted, callers direct, tests migrated)
- [x] lifecycle widget decoded in two files with a bare string key; `TERMINAL` set unused at one writer (one `decodeLifecycleWidget` in `src/pi-rpc/protocol.ts`)
- [x] queue-state built by hand at two sites; queued-reject loop duplicated (`src/acp/session.ts`, `publishQueueState` + shared `rejectQueued`)
- [x] tool-card start built three times (`src/acp/session.ts`, one `emitToolCallStart`)
- [x] `SessionManager` constructed `PiAcpSession` twice verbatim (`src/acp/session-manager.ts`, one `buildSession`)
- [x] `PI_FEATURE_MIN_VERSION` dead table + its test (deleted)
- [x] `pi-commands`: unused param, unread `raw` field, `any` root (removed/typed)
- [x] `initialize`: constant protocolVersion ternary; wrong "pi has no MCP" comment (constant direct; comment reworded)
- [x] stale/wrong comments: orphan JSDoc on `cancel()`, `advertiseCommandsSoon` doc on wrong field, queue-depth comment, `close()` comment, self-declared-unreachable claim (fixed; the defense check kept)
- [x] narrating comments + empty `turn_end` case (~16 sites; deleted)
- [x] dead try/catch around `fileSnapshot`; tool path resolved twice (removed; resolved once at start)
- [x] no-op lines in the extension's `begin` handler (collapsed)
- [x] duplicated config-mutation tail in `setSessionConfigOption` (one shared tail)

## Round 2 findings — fixed in pass 3

P1 (regressions or unfinished work from passes 1–2):

- [x] admission cleanup deleted the close counter while a validation span can still be pending, so a pre-close load can reopen an acknowledged-closed session (`src/acp/agent.ts` — counters retained during validation spans, retry chained on the span tail; discriminating test)
- [x] `killPosixProcessGroup` escalation treats ESRCH as failure; a group that died after the last poll permanently blocks the replacement barrier (`src/pi-rpc/process-tree.ts` — ESRCH = confirmed; two new tests)
- [x] version cache shared across workspaces trusts cwd-sensitive wrappers (`src/pi-rpc/version.ts`, `command.ts` — cwd kept in key for wrapper-capable/unresolved invocations; wrapper-isolation test)
- [x] stdin bridge `detach()` removes the only stdin error listener; a late input error mid-teardown kills the adapter (`src/main.ts` — permanent error sink; test verified crashing on the old bridge)
- [x] POSIX root-exited fail-closed branch locked sessions until restart (`src/pi-rpc/process.ts` — `killTreeTargetsRootPid` gates the pid-addressed fail-closed; group kills settle root-exited children; test)
- [x] coalescing still rendered + stringified suppressed updates on the non-truncated path (`src/acp/session.ts` — raw-text measure before rendering; single path; measure pinned by test)

P2 (worth doing now, same blast radius or loop focus):

- [x] an empty bash update erases the retained suppressed snapshot (`src/acp/session.ts` — only content-bearing snapshots retained; test)
- [x] `PiAssistantMessageEvent` still declared dead `done`/`error` members; stale `lastDoneReason` comment (`src/pi-rpc/protocol.ts`, `src/acp/session.ts`)
- [x] `emitToolCallStart` twin call branches + ignored args (`src/acp/session.ts`)
- [x] `renderGenericBashContent` private-method test seam (`src/acp/session.ts` — deleted; test counts observable behavior)
- [x] two bounded-batch helpers (`boundedAll` exported from session-store, `readRecordFiles` deleted)
- [x] kill-decision duplicated between spawn and version probe; twin `.then` blocks (`killProbeTree` single promise + one `.then`)
- [x] `usageFor` plain pass-through (`src/acp/agent.ts` — deleted)
- [x] stdin bridge `bridging` flag + wrong comments (`src/main.ts`)
- [x] raw-path comment copies; `genericBashSnapshots` rationale copies; "For now we always export" note (deduplicated)
- [x] `SessionCreateParams` `[key: string]: unknown` (removed; 5 test files cleaned)
- [x] ~~rolling bash delta scans the whole window~~ **rejected in fix-3 with proof**: the fresh-region backwards-scan variant loses data on incoherent metadata (randomized 20k-case differential: lying `outputLines` yields a mis-split delta); the whole-window newline verification is load-bearing. The forward scan stays; the differential test is kept as a permanent pin.

## Round 3 findings — fixed in pass 4

P1 (source-derived counterexamples, not yet reproduced at runtime):

- [x] PATH-resolved wrapper-capable scripts still shared version cache across workspaces (`src/pi-rpc/version.ts` — new `isConcretePiEntry` in command.ts; wrapper-capable PATH entries now per-cwd, concrete direct-JS entries still share; wrapper-isolation + concrete-sharing tests)
- [x] root-exited POSIX version probes bypassed group termination (`src/pi-rpc/version.ts` — exited-root prohibition restricted to pid-addressed kills; POSIX group-kills after root exit; single SIGKILL fallback; real-group test settles in ~0.4s not the 15s timeout)
- [x] raw-byte coalescing measure suppressed updates the old rendered-byte measure emitted (`src/acp/session.ts` — escape-aware `escapedTextByteLength` basis, no rendering of suppressed content; seam-64 + production-threshold regressions; false "never later" comment replaced)

P2 (small, same blast radius):

- [x] pass-3 comment slop (stale "rendered bytes" wording ×2, JSDoc history narration, POSIX-group rationale ×3, terminalize comment half) (`src/acp/session.ts`, `src/pi-rpc/process.ts`)
- [x] `shutdownViaStdinError` hook deleted (direct `shutdown()` call; TDZ-safe) (`src/main.ts`)
- [x] `bashResultText` extracted once per generic in_progress update, passed down (`src/acp/session.ts`, `bashOutputSnapshot` optional param)
- [x] `progressed` operand order restored (`src/acp/translate/bash.ts`)
- [x] `genericBashSnapshots` rationale now lives once (field comment)

## Round 4 findings — fixed in pass 5; loop closed

P1:

- [x] explicit overrides shared version probes across workspaces via JS-shebang forwarding launchers — explicit overrides (bare and absolute) now always per-cwd; default discovery (bun-reroute + recognized direct-JS, with the `..` guard) keeps sharing; trust boundary documented; discriminative tests (`src/pi-rpc/version.ts`, `command.ts`)
- [x] image-only generic bash updates were dropped — image-bearing results are content-bearing in retention and admission (bypass text-growth coalescing, emit immediately, retained for synthetic failure) (`src/acp/session.ts`)

Accepted by parent decision (documented in code):

- [x] escape-aware coalescing measure is a documented approximation, not byte-parity with the old rendered basis (fence overhead, surrogate escapes, image bytes excluded; the 64 KiB threshold is a spam-control heuristic)

P2 (comments) — all fixed:

- [x] `isWrapperCapableScript` JSDoc clause dropped; cache-key JSDoc owns the sharing policy
- [x] re-copied rationales trimmed (dispose() one sentence; probe one-liner referencing `killTreeTargetsRootPid`; measure clause once, on the field)
- [x] main.ts cancel() comment shortened

## Deferred — resolution

- [x] ~~v2 replay gives a retained user message a second identity~~ **closed: blocked upstream** — no pi RPC surface correlates a prompt to its persisted entry id (probed against pi 1.5.0 and its docs: prompt response, user message events, get_state, get_entries, get_fork_messages all lack it; the prompt request id is not persisted). Every join would be a content/ordering heuristic that misattributes on foreign user entries (`pi.sendUserMessage`) and equal prompt texts. `replay:<entryId>` stays — deterministic beats sometimes-wrong. Upstream ask: expose entry ids in live user message events, the prompt response, or persist the request id.
- [x] ~~async file-snapshot reads~~ **closed by owner decision: keep sync** — point-in-time consistency by design; bounded (≤ 1 MiB, local disk), milliseconds at most
- [x] ~~dropping fsync on session upsert~~ **closed by owner decision: keep fsync** — one-off 10–30 ms per session create/restore, off the streaming path; durability of the session-id→file mapping wins
- [x] ~~caching `lstatSync` results in tool-call location translation~~ **closed by decision: not worth the machinery** — traced live rate is at most 1 duplicate stat per tool call (update/coalescing paths never stat); measured 0.79 µs per warm hit, ~0.1 ms per heavy turn, ≤ 3.6 ms one-time for a pathological 1000-call replay. The prescribed invalidation design has a correctness hole (bash-created files at paths cached negative by other tools' args); the sound positive-only variant costs ~15 lines + translator signature changes + a dead-jump-link staleness regression to save sub-µs calls — dominated by the whole-file snapshot reads the owner already kept sync
- [ ] 13 reviewer-dropped micro findings (two `split()`-based counters, `line.trim()` before parse, linear `Array.find`, restore try/finally dup, auth-error block dup, mid-file import, staged-prompt dup, two one-line wrappers, `assertNotDisposed` overlap, error `name` unset, five eslint-disabled `as any` casts) — worker in flight
