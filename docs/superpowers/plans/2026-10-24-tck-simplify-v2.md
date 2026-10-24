# TCK Simplification + ACP v2 Support Implementation Plan

> **For agentic workers:** Use the installed pi-subagents workflow-script surface; the parent owns orchestration and acceptance. Workers run serially (stacked branches force it); no parallel writers in one checkout.

**Goal:** Two stacked PRs from current `origin/main` (7d75d554): (A) simplify the TCK harness while keeping strong isolated tests and deterministic TCK coverage, and (B) upgrade to `@agentclientprotocol/sdk` 2.x and add experimental ACP v2 routing, preserving v1.

**Architecture:** PR A rewrites the open PR #2 branch (`test/acp-tck-diagnostics`) rebased onto `origin/main` with the overbuilt probe-tree hardening reverted to bounded synchronous probes; registry teardown, honest-exit/report validation and isolation stay because each maps to a review-proven real defect. PR B stacks on that branch: SDK 2.x upgrade, then a v1/v2 router selected by `initialize` negotiation (codex-acp `AcpAgentRouter` pattern), exposing only v2 methods pi can honestly back.

**Tech Stack:** Existing Node scripts, node:test, `@agentclientprotocol/sdk` 2.x (peers: codex-acp ~2.0.0, claude-agent-acp 2.0.1), GitHub Actions.

**Spec:** User decisions 2026-10-24: target the harness-simplification and protocol-v2 gaps (chosen over MCP/E2E this cycle), two stacked PRs, base `origin/main`. Reference adapters at agentclientprotocol/codex-acp@a77829fe and claude-agent-acp@ebfbfbd are evidence, not authority.

## Global Constraints

- PR A changes only harness/test/doc/CI files (scripts/_tck_, test/unit/acp-tck\*, docs/adapter-reference.md, .github/workflows/ci.yml, package.json scripts). No production `src/` changes.
- PR B touches `src/acp`, package.json dependency, focused tests; v1 wire behavior must remain identical (full existing suite + `eval:tck` v1 pin stay green).
- The TCK runner stays pinned to protocol v1 and revision 3d46e216; the upstream v2 TCK suite is explicitly out of scope (unstable draft). Record as deferred.
- MCP servers stay rejected on both v1 and v2 (unchanged this cycle; user deferred that gap).
- No real provider calls, credentials, user state, or live Zed UI coverage; deterministic isolated coverage only.
- No new runtime dependencies beyond the SDK upgrade; no schema/framework additions.
- Force-push consequence (user-approved by choosing "2 stacked PRs from origin/main"): PR #2's branch is rewritten (rebase + simplification). Nothing else is force-pushed.
- One writer at a time in this checkout; NUL-safe baseline captured before each writer; no stash/reset/discard of unrelated work; no worktrees.
- Format touched files; report actual commands/exits honestly; stop conditions below are hard.

## Topology / lane board (multi-seam, serialized by stacking)

| Lane                    | Repo/cwd                                                                            | Exact decision / files                           | Isolation                       | Gate                                                                              | Handoff                      |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| A: simplify harness     | /Users/regadas/src/pi-acp, branch test/acp-tck-diagnostics rebased onto origin/main | Probe machinery revert + test/doc trims          | Same checkout, sole writer      | Focused suite, full validate, real pinned v1 TCK on Pi 1.2.0, force-push PR #2    | Updated PR #2                |
| B: SDK 2.x + v2 routing | Same checkout, new branch stacked on updated test/acp-tck-diagnostics               | src/acp router + SDK upgrade + v2 subset + tests | Same checkout after A completes | Full validate, v1 TCK still green, v2 negotiation/lifecycle tests, new stacked PR | New PR (base = PR #2 branch) |
| Fresh review            | Read-only, both PR diffs                                                            | 4 seats, per-target findings                     | None (no writer)                | Evidence-backed P0/P1/P2 + verdicts                                               | Managed reports              |
| C: fixes                | Same checkout, serial                                                               | Parent-accepted findings only                    | Same checkout                   | Affected checks + targeted re-review                                              | Final states                 |

Protected parent-owned plan file. Recapture baseline before each writer. The stack means lane B starts only after lane A's branch is pushed.

## Review Focus

- Simplification must not reopen review-proven defects: honest exit/report mapping, isolation/credential scrub, agent teardown on timeout, late-bootstrap fail-close, pin enforcement, cancellation exercise.
- The probe revert is justified only if plain non-detached `spawnSync` probes keep the documented bounded-setup guarantee (natural signal propagation replaces detached-group machinery). Docs must not overclaim process-group kills.
- SDK 2.x upgrade must not drift v1 wire behavior; v2 advertisement must only include what pi RPC actually backs (no fork/terminals/subagent sessions/providers/steering).
- v2 negotiation must mirror peers: v2-capable client asked for 1 still gets v1; v1-only client never sees v2 methods.

## Task A: Simplify the TCK harness (rewrites PR #2)

**Files:** scripts/eval-acp-tck.mjs, scripts/fixtures/acp-tck-agent-bootstrap.mjs (minor trims only), test/unit/acp-tck.test.ts, docs/adapter-reference.md, .github/workflows/ci.yml (only if probe wording/job changes), package.json (no change expected).

- [ ] Capture baseline; rebase `test/acp-tck-diagnostics` onto `origin/main` (7d75d554); resolve conflicts (docs/adapter-reference.md likely; main touched src/acp + docs). Stop and report if conflicts exceed mechanical resolution.
- [ ] Revert the async probe machinery (pending-close ownership, forced settlement, probe SIGINT/SIGTERM handlers, `PROBE_FORCE_GRACE_MS`) to bounded `spawnSync`/`execFileSync` probes with `timeout: min(PROBE_TIMEOUT_MS, remaining)` and `killSignal: 'SIGKILL'`. Not detached: external signals reach probe children naturally. Keep budget validation before probes.
- [ ] Keep intact: pin checks, `withoutUntrustedOverrides` env scrub, report validation (all four tiers/counts) and exit/verdict mapping, registry bootstrap + seal + identity revalidation teardown, watchdog, `--cancel-prompt` cancellation exercise, passthrough allowlist, private per-run uv state.
- [ ] Remove tests that only exercised the removed probe machinery (pipe-holding leader cases, probe interruption case); trim orphaned helpers; adjust any assertions/docs that claimed whole-process-group probe kills. Keep the setup-failure table minus deleted modes.
- [ ] Focused suite, full `npm run validate`, real pinned v1 TCK on Pi 1.2.0 against a fresh clone; confirm no leaked owned processes. Force-push PR #2; update its body if the description changed materially.

## Task B: SDK 2.x upgrade + experimental v2 routing (stacked PR)

**Files:** package.json (dependency), src/acp/app.ts (router), src/acp/agent.ts (negotiation + v2 handlers or a v2 sibling module), focused tests under test/; docs/adapter-reference.md (status/features).

- [ ] Branch from the updated `test/acp-tck-diagnostics` (e.g. `feat/acp-v2-routing`). Inspect SDK 2.x changes first (changelog, export layout; reference codex-acp's imports `@agentclientprotocol/sdk/unstable` + `sdk/experimental/v2/unstable`). Stop and report if the v1 builder API is gone rather than relocated.
- [ ] Upgrade the SDK; adapt imports/types with zero v1 behavior drift (entire existing suite must stay green unchanged in substance).
- [ ] Add a router that selects the v1 or v2 handler chain from `initialize` (peers' pattern). v2 subset backed by pi RPC: initialize, session/new, list, resume-with-replay, close, delete, prompt, cancel, setConfigOption. Advertise honestly; reject non-empty mcpServers on v2 exactly as v1 does.
- [ ] Add focused v2 tests: negotiation both directions, one v2 session lifecycle (new → prompt via deterministic local provider → cancel path or close), v2 config option, and a v1 regression pin. No provider network.
- [ ] Full `npm run validate`; confirm `eval:tck` (v1) still green on the stacked branch; open the stacked PR (base = test/acp-tck-diagnostics).

## Stop conditions

- Rebase conflicts beyond mechanical docs/test resolution.
- SDK 2.x removed (not relocated) the v1 builder surface, or v2 exports unusable without forking our process model.
- Any simplification that would reopen a review-proven defect — escalate to the parent with the specific defect instead of trading it away.
- CI/live GitHub Actions failures not reproducible locally.

## Parent acceptance / review sequence

- [ ] Inspect both handoffs and diffs; recapture NUL-safe baselines; run/confirm validation evidence (including real pinned v1 TCK on the final stacked head).
- [ ] Fresh full-mode review: Sol/xhigh (correctness), Opus/medium (architecture/lifecycle), Sonnet/xhigh (tests), Gemini/high (operability) — each receives both PR diffs (A: branch vs origin/main, plus the simplification delta vs the pre-simplify snapshot; B: stacked branch vs A's branch) and returns per-target findings.
- [ ] Verify seat model/effort/family from native receipts; adjudicate on source/runtime evidence, no votes-as-proof.
- [ ] One fix worker applies only accepted findings (lane C), recapturing the baseline first; targeted retained-seat verification of fixes and blast radius; cap at two fix rounds this cycle.
- [ ] Record receipts (routing, wall time, reported cost, dispositions); leave both PRs open for user merge; do not merge or close anything without the user.
