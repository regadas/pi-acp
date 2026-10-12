# ACP Owned Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The parent owns delegation; an implementation child executes its assigned tasks without spawning agents.

**Goal:** Prevent ACP foreground completion while observed required async work or its delivery remains outstanding, while preserving explicit detachment.

**Architecture:** Extend the existing adapter-owned Pi extension with a before-settlement barrier, exact required-root/delivery bookkeeping, and an `acp_detach` tool. Keep native `agent_settled` as the eventual ACP release signal. The post-publication amendment removes supplementary system-prompt policy while preserving the admission/correlation hook; older steps below record the superseded initial approach.

**Tech Stack:** TypeScript, Node 22.19+, ACP SDK 1.4, public Pi extension APIs at 1.1.0+, existing optional subagents v1 status/notification surfaces, node:test, scripted local providers.

**Spec:** `docs/superpowers/specs/2026-10-11-acp-owned-completion-design.md` (approved by the user).

## Approved prompt-only follow-up (2026-10-12)

The user approved one additional commit/push and Nix pin/build after the post-publication assessment. Remove only the system-prompt appendix; preserve the lifecycle barrier, `acp_detach` description, input/image correlation and discovered resources. Do not move guidance into CLI flags, tool prompt snippets/guidelines or a substitute resource. No new configuration, backoff, weaker validation, upstream/host changes or activation.

- [ ] Capture clean published baseline; parent amends spec/plan, then captures the worker baseline with both parent documents protected.
- [ ] One retained writer changes the prompt test first and proves semantic RED; removes the constant/supplement clause and updates related fixture/eval assertions and truthful README/audit documentation.
- [ ] Narrow formatting, extension/unit GREEN, native validation/smoke; focused real-Pi new/resumed resource and lifecycle-ordering checks on final bytes. No unchanged cancel matrix repeat.
- [ ] Fresh targeted reviewers verify the removal, correlation/resource preservation and evidence; parent accepts findings before one additional commit/push.
- [ ] Parent updates/builds the Nix pin without activation. Report real-model detach and live Zed/Windows limitations honestly.

## Global Constraints

- Adapter-only: no edits to Pi, pi-subagents, Zed, Nix, host configuration or project dependencies.
- Pi minimum is exactly `1.1.0`; it is also the current published release, so one representative real-Pi runtime covers minimum/current.
- First revert only `32bfbd472e9e41433a184501fafe68edd7c97519` with `git --no-replace-objects revert --no-commit`. This user-authorized revert may stage its inverse; do not create a commit, stage unrelated work or revert the earlier audit fixes.
- Custom-message arrivals are not observable while a boundary handler awaits. Approved continuation probes use a validated waiting draft when needed, at most once per `1_000` ms for the owner and at most 30 per terminal capture, within its delivery deadline. Extra provider calls are permitted, not successful-delivery proof.
- User approved owned supervisor-wake continuations after the first full review. Share the owner's `1_000` ms probe cadence; allow at most 30 attention probes within `30_000` ms per distinct attributable supervisor episode. Matching request consumption ends that delivery window; generic inactivity is not a request, duplicate/stale evidence cannot reset the budget, and no overall child-runtime timeout is added.
- Later actual-runtime traces prove that promoted workflow children emit delayed native completion notices; the earlier observation ended prematurely. The user chose native-child-notice delivery only, superseding the collection exception. Keep unique run/key mapping and exhaustive folded terminal proof, require the child's matching notice and a later provider response, and retain the same 30-attempt/30-second terminal-delivery bounds. `bg_wait` collection and status/control queries never substitute for notices or create ownership.
- Keep children async; never interpret `async: true` as detachment.
- Explicit detach uses `acp_detach({ runIds: string[] })`; only current newly owned roots are eligible, with atomic batch validation.
- Preserve FIFO/admission/native correlation and bounded exact-owner cancellation. Do not wait for or stop unrelated/detached work.
- Preserve all rendered user prompt resources. No adapter-generated `--append-system-prompt`.
- Each proven-terminal required capture has a `30_000` ms delivery-proof window. Expiry/missing proof is an error, never success; stop the deadline after native delivery consumption, not after synthesis. Other running roots do not prevent probing that capture. Latch exact terminal proof across stock's 10-second completed-record retention, resetting on owner/session/file change or launch/revival recapture. Ambiguous reused-ID delivery is unsupported, not proof. No overall job runtime limit.
- Bounded/omitted/ambiguous status and missing structured notification IDs are unsupported evidence, not quiescence. Runtime authority is the user's clean git-main checkout at `29284cd943c0c7ee852593c6e02d2a60febf6ba4`, not a same-version npm artifact. No historical subagents compatibility matrix.
- No new general task framework, private runner state, monkeypatching, semantic prompt parser, synchronous substitution or dependency.
- No commits, pushes, publication or activation. Parent documents and unrelated dirty paths remain protected; request approval for any overlap outside the captured target.

## Implementation Topology

One coupled lifecycle seam, one writer in `/Users/regadas/src/pi-acp`. Prompt augmentation, ownership/barrier, tool registration, cancellation and their fixture hooks share `acp-extension.ts` and its harness; splitting them would create overlapping file ownership and artificial intermediate contracts. Version/caller corrections and evidence belong to this feature, not independent writer lanes.

Parent stages: capture baseline → worker executes Tasks 1–3 → fresh full-mode source review → parent accepts findings → one fix worker applies accepted scope → targeted validation/re-review of material fixes. Record each actual review model/effort/family. Stop on runner failure or a material missing capability; do not change execution protocols or expand scope.

## Review Focus

1. Native wake races or delivery after final-looking text: release only after exact required delivery and a completed post-delivery provider cycle.
2. Mixed required/detached/foreign jobs and cancellation: only current required roots/proven descendants affect ownership; global busy state is not a scoped predicate.
3. Terminal roots, virtual display steps, omitted/deep subtrees and malformed ancestry: do not confuse a display row or terminal root with exhaustive real-run proof.
4. Fast/duplicate/stale notifications, session resume and invalid mixed detach batches: retain exact origin, validate atomically, and never gain authority from an old notice.
5. Prompt-resource trust, schema dispatch and version floor: existing APPEND_SYSTEM content survives; the new tool and hook work in real Pi, not only the fake harness.

---

### Task 1: Restore prompt resources and set the supported Pi floor

**Files:**

- Modify: `src/pi-rpc/process.ts`, `src/pi-rpc/acp-extension.ts`, `src/pi-rpc/version.ts`.
- Test: `test/unit/pi-version.test.ts`, `test/unit/pi-version-spawn.test.ts`, `test/unit/acp-extension.test.ts`; accepted-version fixture in `test/component/session-command-fifo.test.ts` where applicable.
- Classify the references in `src/acp/session.ts`: correct only overall-minimum wording if needed, preserving the historical native `agent_settled` feature floor. Keep historical/rejection cases accurate; do not blanket-replace older versions.

**Interfaces:**

- Consumes: current centralized RPC spawn argv and `before_agent_start`'s rendered `systemPrompt`.
- Produces: `MIN_PI_VERSION = '1.1.0'`; new/resumed default argv without adapter append flags; `before_agent_start` returning the entire original prompt plus ACP supplementary policy.
- The policy describes required roots and `acp_detach`, not a mandatory external wait tool. Do not append repeatedly to a previously augmented prompt or reconstruct resource discovery.

- [ ] **Step 0: Apply the requested guidance revert before feature edits.** Confirm the commit is an ancestor of the captured HEAD and changes only README/process/version tests. Apply `git --no-replace-objects revert --no-commit 32bfbd472e9e41433a184501fafe68edd7c97519`. Verify the inverse excludes the audit fixes and protected parent documents. If Git reports conflicts or an unexpected target, stop for the parent rather than reset/abort/discard work. Keep the revert as an uncommitted inverse while implementing its replacement.
- [ ] **Step 1: Write failing regression assertions** in the existing suites:

  ```ts
  assert.equal(argv.includes('--append-system-prompt'), false)
  assert.ok(renderedPrompt.includes('GLOBAL_APPEND_SENTINEL'))
  assert.ok(renderedPrompt.includes('acp_detach'))
  assert.equal(MIN_PI_VERSION, '1.1.0')
  ```

  Cover new and resumed default spawn, preservation of explicitly user-supplied command arguments, rejection below 1.1.0, acceptance at 1.1.0, and preserved system-prompt prefix in the extension hook. Restore any useful argv instrumentation removed by the revert only as required for these new tests.

- [ ] **Step 2: Verify RED.** Run `node --import tsx --test test/unit/pi-version.test.ts test/unit/pi-version-spawn.test.ts test/unit/acp-extension.test.ts`. Confirm failures reflect the new contract, not a broken fixture.
- [ ] **Step 3: Implement the minimal corrections.** Remove generated append arguments/constant from `process.ts`; append policy through the existing extension hook; update minimum checks/messages and accepted-version fixture values. Do not rewrite version parsing or historical evidence.
- [ ] **Step 4: Verify GREEN and typecheck.** Repeat the focused command and run `npm run typecheck`. Preserve existing admission/correlation hook behavior while widening typed handler results as required.

### Task 2: Enforce owned completion and explicit detachment

**Files:**

- Modify: `src/pi-rpc/acp-extension.ts`.
- Modify `src/acp/session.ts` only for a demonstrated error/cancellation attribution need; do not add a second aggregate background-completion barrier.
- Test: `test/unit/acp-extension.test.ts`; connected component suites `session-background.test.ts`, `session-native-admission.test.ts`, `session-responsiveness.test.ts` only where the new contract is exercised.

**Interfaces:**

- Consumes: current owner/session/file/admission, `tool_result` input/result origin plus actual launch `details.asyncId`, public `subagents:rpc:v1` status, `subagent-notify` structured details, public Pi context/message/turn/boundary events and abort signal.
- Produces: `acp_detach({ runIds: string[] })` through `registerTool`; awaited `agent_before_settle` returning boundary continuation/drafts or normal settlement; current-owner lifecycle error for unsupported/failed proof.
- Extend the existing test `harness()` to retain handler results, expose registered-tool invocation, and model boundary/context/abort events. Use its EventEmitter response style and controlled timers; do not create a new generic test framework.
- Local state representation/helpers are builder decisions. Keep the module standalone and explicitly typed; reuse canonical lineage validation. Do not introduce public production helpers merely for tests.

- [ ] **Step 1: Write failing required-work/ordering tests.** Name cases `required root prevents settlement`, `notice consumed before final provider cycle`, `delivery racing boundary`, `final text predates delivery`, and `new root from continuation remains required`.

  ```ts
  assert.equal(settled, false) // running required root, even after parent yields
  assert.equal(settled, false) // root terminal but matching delivery absent
  assert.equal(settled, false) // delivery consumed but no later provider completion
  assert.equal(settled, true) // fresh exact proof plus post-delivery provider cycle
  ```

  Distinguish status `complete` from notice `completed`; include notice-before-observation and queued wake ordering. Never block `message_start` by awaiting it inside the boundary that must yield first. Add `fast provider with notice after probe`, `terminal capture delivery while another root runs`, `probe needs runnable draft`, `probe cadence and count bound`, and `terminal proof survives completed-record retention`. Preview `canContinue: false` with assistant-final/no queue may become runnable through the waiting draft; native hard error/abort never may. Probe drafts must preserve prior entries and cannot satisfy delivery proof.

- [ ] **Step 2: Write failing ownership/negative tests.** Cover atomic detach including a valid+foreign batch, duplicates, stale/previously detached IDs, same owner with changed session/file, and a previously detached root's later notice. A status/control result naming an old ID must not be captured as a launch; revive counts only when it actually creates newly owned work. Cover mixed required/detached/foreign work with cancel and a subsequent prompt:

  ```ts
  assert.deepEqual(stoppedIds, [requiredRoot])
  assert.equal(stoppedIds.includes(detachedRoot), false)
  assert.equal(stoppedIds.includes(foreignRoot), false)
  assert.equal(requiredIds.includes(previousOwnerRoot), false)
  ```

  Add terminal-root/live-descendant, virtual plan step versus real canonical child, missing/truncated roots/IDs, malformed lineage, missing metadata/0.67-style notice, status failure, attention/supervisor wake, native cannot-continue outcome, shutdown/abort and stale awaited replies. Failure/quarantine with foreign work must not terminate that work; assert survival, not just absence of a stop RPC.

- [ ] **Step 3: Write the delivery-deadline assertion using the existing controlled timer API.** After proven terminal required work without consumable matching delivery, advance `30_000` ms; assert a current-owner error, never successful release. Assert cancellation and valid delivery resolve before expiry. Running required work does not inherit this terminal-only deadline.
- [ ] **Step 4: Verify RED.** Run `node --import tsx --test test/unit/acp-extension.test.ts test/component/session-background.test.ts test/component/session-native-admission.test.ts test/component/session-responsiveness.test.ts`.
- [ ] **Step 5: Implement the barrier and tool.** Default newly captured launches to required. Validate all detach targets before removal; never stop them. Await exact public evidence with responsive abort/revalidation. For missing consumed delivery of a proven-terminal capture, use the approved rate/deadline/count-bounded draft continuation; entry-time matching queued notices may yield immediately. Never use `ctx.hasPendingMessages()` as custom-queue visibility or a bare continuation that Pi may reject for empty runnable context. Preserve other handlers' entries. Only matching native consumption plus a later provider cycle permits release. Surface capability/lineage/deadline failure through the owner error path.
- [ ] **Step 6: Reconcile cancellation conservatively.** Detach removes authority; aggregate activity cannot wait on detached/foreign roots. Preserve bounded stop/quarantine/warning semantics without making a lossy snapshot successful proof or introducing broad shutdown of foreign work. Escalate if the public contract cannot support a requested guarantee.
- [ ] **Step 7: Verify GREEN.** Repeat focused tests and typecheck. Retain native-settlement/FIFO characterization tests: a valid native `agent_settled` still releases ACP; enforcement is before that signal. Do not blanket-rewrite responsiveness tests to wait for all background jobs.

### Task 3: Prove the real mechanism and document its limits

**Files:**

- Modify: `scripts/eval-acp-client.mjs`, `scripts/fixtures/acp-harness-extension.ts`.
- Create: `scripts/eval-subagents-completion.mjs`, `scripts/fixtures/subagents-completion-provider.ts`, following the existing stock-cancellation eval/provider patterns. Reuse their infrastructure where safe; these files are a deterministic assertion-based self-check, not a new test framework.
- Accept `PI_ACP_EVAL_SUBAGENTS` as an explicit git checkout root; record and verify revision `29284cd943c0c7ee852593c6e02d2a60febf6ba4`, clean source status and its declared `index.ts` entry. Use the installed checkout read-only. Explicitly retarget the existing cancellation eval to this same user-approved git revision; do not install, shim or investigate historical subagents versions.
- Modify: `README.md`, `docs/acp-compatibility-audit.md`; script runner/export configuration only if necessary to invoke the new evidence.

**Interfaces:**

- Consumes: built `dist/index.js`, `PI_ACP_EVAL_PI`, deterministic scripted provider, fixture-host public status/notification behavior, isolated temp HOME/session directories.
- Produces: ordered ACP/runtime evidence for prompt lifetime, tool dispatch, exact IDs, post-delivery response and capability failures; accurate docs separating fixture, stock runtime and live-client claims.

- [ ] **Step 1: Add a deterministic real-Pi early-yield scenario before completing the implementation.** Provider launches async required work then deliberately ends its response without calling a wait tool. Fixture delivers a structured matching completion later. Assert:

  ```ts
  assert.ok(finalSynthesisChunkIndex < promptResponseIndex)
  assert.equal(promptResponse.stopReason, 'end_turn')
  assert.equal(ownedAgentStartsAfterResponse, 0)
  ```

  Confirm the baseline fails this discriminating scenario. Record event order, not elapsed-time guesses.

- [ ] **Step 2: Exercise the real detach schema/dispatch.** Add explicit detach, mixed/foreign work, cancel during the boundary, queued supervisor wake, delayed/fast delivery, terminal root/live descendant, missing/ambiguous proof and resume. Assert exact cancellation IDs and that old/foreign roots do not affect new ownership. Add APPEND_SYSTEM/provider sentinel assertions for new/resumed requests.
- [ ] **Step 3: Run real-runtime evidence on Pi 1.1.0.** Run `node scripts/eval-acp-client.mjs`, `node scripts/eval-subagents-completion.mjs` and the explicitly retargeted cancellation eval with installed Pi 1.1.0, isolated fixture state and `PI_ACP_EVAL_SUBAGENTS` selecting the user's git-main checkout at `29284cd943c0c7ee852593c6e02d2a60febf6ba4`. Record/revalidate exact revision, clean status and loaded `index.ts`, proving notification/status behavior rather than a fake host or an npm package label. Include a genuinely fast scripted provider whose native notice queues after a probe, and demonstrate valid runnable waiting drafts. Record possible extra model calls and clock/deadline limits. Missing metadata cases may use clearly labeled public fixture-injected negative messages, not claims about an untested historical runner. If capabilities are unavailable, report the precise blocker; no invented coverage or further version archaeology.
- [ ] **Step 4: Update docs with proven behavior.** Explain Pi 1.1.0 floor, explicit detach, FIFO/cancel trade-offs, runtime capability limits, terminal-only delivery deadline and bounded probes' possible extra provider calls/latency. Replace stale aggregate-completion claims in the audit without rewriting historical receipts. Do not claim a live Zed spinner/bell trace exists.
- [ ] **Step 5: Format only touched files.** Parent spec/plan and unrelated dirty work are protected. Use the installed Prettier with an explicit touched-file list; whole-worktree formatting is permitted only if all affected paths are authorized.
- [ ] **Step 6: Run final checks.** `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, and the relevant deterministic eval commands. Capture bounded output/evidence. Any skip/failure is reported, not replaced by model confidence.
- [ ] **Step 7: Return the implementation handoff.** List actual changed paths, command/results, runtime versions/capabilities, retained temp evidence, remaining limits and source anchors. No commit/push. Stop for a concrete blocker rather than widening scope.

### Task 4: Apply parent-accepted first-review fixes

**Files:** `src/pi-rpc/acp-extension.ts`, `test/unit/acp-extension.test.ts`, connected completion/cancel/client evals and their existing fixtures, `README.md`, `docs/acp-compatibility-audit.md`. The parent captures exact writable overlap before the single fix worker starts; spec/plan and all other dirty paths remain protected.

**Interfaces:** Extend the existing capture/delivery state, public status and structured message observation; do not add a new queue protocol, change FIFO failure policy, alter installed runners or read private state.

- [ ] **Step 1: Obtain focused RED evidence for accepted lifecycle failures.** Known promoted descendants must require their own delivery and later provider response, remain assessable after parent retention expiry, reject incomplete terminal proof, and be included in exact-owner cancellation. Add delayed-consumption/expired-preview deadline cases, whitespace-normalized resume, validated steering-recovery replacement capture, and rejected/malformed stale-owner polls. Status/control names alone must never confer ownership.
- [ ] **Step 2: Repair that single lifecycle seam and verify GREEN.** Keep associated descendants/attention detachable only through the captured root. Enforce delivery deadlines at consumption and before preview shortcuts; stop deadlines after timely consumption. Give new owners fresh status assessment without stale error authority. Use position-independent waiting wording that handles notices occurring after the draft.
- [ ] **Step 3: RED/GREEN the approved owned supervisor-wake path.** Demonstrate a running child's request queued after barrier entry, exact association, parent consumption/reply before child termination, and final completion/synthesis before ACP response. Cover duplicate/stale/foreign/detached attention, owner replacement, shared cadence, 30-attempt/30-second attention-delivery bounds, and cancellation. Escalate missing public attribution/episode metadata; do not silently omit this acceptance case.
- [ ] **Step 4: Calibrate deterministic evidence.** Implement the user's final native-child-notice decision, removing the superseded collection exception. Keep exact promoted-child/run/key mapping and uniquely matched real-step terminal proof under the validated root; require the child's matching notice and a later provider response before ACP completion. Prove collection-only delivery cannot release the request, including post-terminal `bg_wait`, and retain terminal-fold completeness, detach and promoted-child cancellation coverage. Verify actual stock child notices rather than assuming their absence from the earlier prematurely ended trace. Distinguish nested final synthesis from early yield; make early-yield/post-response ordering checks discriminating; require real foreign PIDs; restore aborted/no-gate-release nested cancel assertions; use isolated discovered `APPEND_SYSTEM.md` on new/resumed sessions; exercise notice consumption before/at barrier entry, not merely mid-barrier probing. Preserve genuine pre-change RED artifacts.
- [ ] **Step 5: Correct documentation and validate.** Scoped completion failures preserve the channel; retain existing queued-turn rejection semantics. Correct historical Zed fixture count to 25, separating new check counts and fixture evidence from live Zed/Windows claims. Narrow-format touched files, run focused tests, typecheck/lint, full `npm run validate`, smoke, and affected real-runtime scenarios on Pi `1.1.0` / clean git-main `29284cd` without a historical matrix. Required checks may be completed in serial retained-worker phases to avoid runner timeouts; no premature reviewer launch.
- [ ] **Step 6: Parent accepts evidence and launches fresh targeted re-review.** Supply exact reviewed fix bytes, before/after evidence and actual Pi `1.1.0` boundary source rather than a `1.0.4` proxy. Verify actual final models/efforts/families, adjudicate residual findings and report completion or a concrete blocker. No publication.

## Fresh Review and Fix Handoff

Parent verifies candidate bytes/baseline preservation and supplies the actual changed paths, relevant contracts, source/test entry points and runtime evidence. Reviewers are fresh and read-only: Sol 6.1/xhigh correctness, Opus/medium lifecycle, Sonnet/xhigh tests, Gemini/high operability. Verify actual native models/families; incomplete coverage is not approval.

Parent dispositions findings against source and tests. Before the single fix worker writes, recapture staged/unstaged/untracked state, protect unrelated work, and explicitly authorize only accepted overlap. Material fixes receive affected tests/runtime checks and fresh targeted review under the packaged three-round default cap. No findings means no unnecessary fix edits or redundant check loop. Publication remains a separate decision.
