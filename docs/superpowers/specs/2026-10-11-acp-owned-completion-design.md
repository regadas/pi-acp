# ACP owned completion

## Intent

Keep an ACP end-to-end task busy while its required async work is outstanding, then release the prompt after completion delivery and the parent's response to it. Avoid Zed's premature completion indication without replacing async execution with synchronous children or treating every session job as this task's dependency.

This is one adapter lifecycle change, not a general task framework or an ACP protocol extension. Model interpretation still selects user intent and the final answer; the adapter enforces the lifetime of observed required work.

## User-approved decisions

- Implementation stays inside `pi-acp`; do not modify `pi-subagents`, Pi, Zed, Nix, or global configuration.
- Require Pi `1.1.0` to simplify compatibility testing. Raising the floor does not itself provide live queue visibility.
- Revert guidance-only commit `32bfbd472e9e41433a184501fafe68edd7c97519` before implementation, without creating a commit or reverting the earlier audit fixes.
- Permit bounded adapter-only continuation probes, with possible extra provider calls, to handle unobservable custom-message queue arrivals.
- After the first full review, explicitly permit bounded native continuations for supervisor requests from exact owned work while children remain running: at most one attention probe per `1_000` ms for the owner, at most 30 attempts in a `30_000` ms attention-delivery window. Matching request consumption ends that window; it is not an overall child-runtime timeout.
- Required delegation remains asynchronous.
- Subsequent actual-runtime traces corrected the earlier claim that workflow children emit no completion notices: git-main emits delayed child notices. The user chose native-child-notice delivery only, superseding the collection exception. Validate unique child-run/workflow-key association and exhaustive terminal proof, then require the child's matching notice and a later provider response. A `bg_wait` collection is not notice delivery. Keep the same 30-attempt/30-second terminal delivery bounds.
- Natural-language background requests use a new model-callable adapter tool to explicitly detach exact newly owned roots. Do not infer detachment from `async: true`.
- Preserve existing FIFO input and bounded cancellation behavior. No new steering or follow-up protocol.
- Use one implementation worker, fresh read-only reviewers, and one fix worker for findings accepted by the parent. No commits or publication in this implementation phase.

## Completion contract

1. Bind the existing fresh ACP owner token to the Pi session ID/file before dispatch. Capture only async roots launched or newly revived by this owner's foreground execution. Status/control queries must not adopt an existing run merely because a result names its ID.
2. Captured roots are required by default. Previously detached, restored, foreign, and stale-owner work never enters the required set.
3. Use awaited `agent_before_settle` as the barrier. `agent_settled` remains notification-only and the ACP session's eventual settlement signal.
4. Inspect exact captured roots through the existing public v1 status bridge. Treat display snapshots as bounded evidence: require validated identity, canonical descendant ancestry, and sufficient completeness. A terminal root alone is not proof that descendants or delivery have drained.
5. Observe `subagent-notify` messages through public Pi message events and boundary context. Match structured `details.runs` IDs against the current owner. Do not parse rendered notification prose, read private runner globals, or monkeypatch runner internals.
6. A notice queued during the barrier must be consumed through a native continuation. The boundary's pending-message preview is an entry-time snapshot; `ctx.hasPendingMessages()` does not count queued custom notifications. Never await `message_start` inside the callback that must return before Pi consumes it. While any exact required capture is proven terminal but lacks consumed delivery, permit a continuation probe at most once per `1_000` ms for this owner, capped at 30 probes per terminal capture and its delivery deadline. Preserve existing drafts and add an extension-authored, non-assistant `custom_message` waiting instruction when needed to make the continuation runnable. A bare `continue: true` with an assistant-final, empty queue is insufficient. Matching queued notices in the entry preview may use native continuation immediately. Probe drafts are not result-delivery proof. Extra context-only provider calls are an explicit cost of this adapter-only approach.
7. Track a model/provider-context cycle completed after the last required notice was consumed. Final-looking text, `agent_end`, root termination, and a progress message are not substitutes. If the latest response predates delivery, request one continuation with the existing boundary draft contract. Preserve drafts produced by other handlers.
8. New required roots launched by that continuation extend the same owner. Settle only when required work is demonstrably terminal, matching delivery was consumed, and the post-delivery model cycle completed with no newer required obligation.
9. Queued/unrelated native messages retain Pi's normal behavior but never gain required membership or cancellation authority. A later ACP request gets a fresh owner and does not adopt old work.
10. Stop waiting on cancellation, owner/session replacement, shutdown, and hard native error/abort outcomes. Preserve native exits and the existing explicit owner-cancellation transaction; do not rely on an unavailable boundary `ctx.signal`. An assistant-final preview lacking queued messages may become runnable through the approved waiting draft; never override a hard native exit. For exact-owned root stops, the user approved retrying `execution_failed` only for the stock's observed closed-inbox/shutdown error within the unchanged cancellation deadline. Unrelated stop failures remain hard failures; the retry/error itself is never termination proof.
11. Failed/paused/partial/stopped results are outcomes for the parent to handle, not successful implementation. Allow the parent to report a blocker or perform authorized follow-up work after delivery. Unresolved lineage, malformed/omitted status, missing delivery metadata, or unsupported capability must be visibly non-success, never an invented drain.
12. No new overall task runtime limit. Preserve the existing bounded v1 RPC timeout. Each exact terminal required capture gets a 30-second delivery-proof window; expiration fails, never succeeds by elapsed time. Stop its delivery deadline after matching notice consumption; subsequent synthesis is not subject to that window. Probe terminal captures even while other required roots remain running. Latch validated terminal proof because stock status removes completed jobs after 10 seconds, scoped to owner/session/file and capture generation; reset on a new launch/revival capture. If public metadata cannot distinguish a same-ID revival's delivery from an old attempt, report unsupported proof rather than reusing it. Tests use a controlled clock; cancellation remains responsive.

### Owned supervisor wakes

Terminal-only probes cannot consume a supervisor request queued while a required child still runs. Use public structured supervisor-wake/message metadata or exact public status attention evidence to permit bounded continuations for that owned work. Do not read private runner state, infer delivery from a probe/provider call, or give foreign/detached work completion or cancellation authority. Validate the association with a captured root or its proven descendants before opening an attention-delivery window.

Share the owner's `1_000` ms probe cadence with terminal-delivery probes. Each distinct, attributable attention episode permits at most 30 attempts within `30_000` ms of observation; late or absent matching supervisor-message consumption fails visibly. Consumption closes the attention window even if the child keeps running or a supervisor response takes longer. Duplicate/stale attention must not reopen its budget. Reset on owner/session/file/capture changes and remove associated attention obligations on detach. Preserve native hard exits, prior-handler drafts, and the ordinary post-notice provider fence. No new overall task/child-runtime timeout or FIFO failure policy is introduced.

Prove an actual child asking its parent after the barrier begins, parent consumption and reply while the child remains running, and eventual completion delivery/synthesis before ACP settlement. Test foreign/detached attention, duplicate/stale signals, attention delivery expiry and cancellation responsiveness. Generic inactivity is not itself proof of a supervisor request: if public metadata cannot attribute or identify a required attention episode sufficiently, report the missing capability rather than claiming coverage.

### Workflow-dispatch child delivery

The tested git-main runner may finish dispatch while explicitly async workflow children remain running. Its structured dispatch notice supplies `workflowRunId`, child `runId` and `workflowKey`. Later traces prove that the promoted children emit delayed native completion notices. An earlier failure ended the observation before a child notice arrived; neither `holdOwedResult` nor launch-receipt documentation established that notices were impossible. Dispatch acknowledgement and child terminal status alone are not result delivery.

For this attributed workflow-dispatch shape, retain the unique child-run/key association under its captured root. Prove terminal state from the exact promoted child row or the uniquely matching real workflow step under that validated root, with the same identity, completeness, truncation and ambiguity checks. A display key alone, duplicate key, virtual planned row or unrelated status is not authority. If public evidence cannot distinguish the real child or exhaustiveness, fail visibly.

Require consumption of the child's matching structured native completion notice, followed by the same later provider-cycle fence as ordinary descendants. A `bg_wait` result-reference collection, status query or control response is not notice delivery and creates no ownership. Do not parse rendered notification prose or read private runner state.

Use the existing terminal obligation's at-most-30 probes, owner-shared `1_000` ms cadence and `30_000` ms consumption window. Timely matching notice consumption ends that window, not synthesis. Root detachment removes child completion/cancellation authority, and no overall job-runtime timeout is added. Runtime tests must cover terminal folding, exact child-notice/provider/ACP ordering, cancellation with promoted children, and rejection of collection-only delivery. Preserve the genuine earlier failure as historical evidence, not as proof that the stock runner lacks notices.

## Explicit detachment

Expose `acp_detach` with parameters `{ runIds: string[] }`.

- Accept only nonempty exact IDs currently required by the active foreground owner and matching Pi session/file.
- Validate the entire batch before modifying ownership; a foreign/stale ID cannot partially detach other targets.
- Remove only those roots and their associated obligations from completion and cancellation authority. Do not stop or interrupt them.
- Reject previously detached or historical targets. Detach descendants only through their captured root, never an arbitrary child ID.
- Unmentioned/new roots remain required. Ordinary explicit background requests should return promptly after this tool succeeds.
- Supplementary model instructions explain that the tool is only for user-requested detachment. Calling it is the explicit operational signal; it is not proof that natural language was interpreted correctly.

## Cancellation and errors

Preserve the existing owner transaction, cancellation/FIFO race protections, bounded deadlines, and honest warnings. Reuse canonical lineage validation. Never restore cancellation authority over detached targets.

A session-wide `isActive()` value is not exact required-work proof. In a mixed required/detached or foreign-work case, it cannot make cancellation wait for unrelated work. Where exact quiescence cannot be proven, report that limitation rather than falsely claiming all children stopped or broadening stop scope. Do not introduce a shutdown/recovery path that stops foreign work merely to resolve a scoped cancellation.

Publish current-owner lifecycle errors through the existing widget/error path; throwing from an extension hook alone is insufficient because Pi may log an extension error and continue. Preserve cancellation classification when cancellation races proof failure. Only matching owner/session evidence may affect the active ACP request.

## Prompt resources

Remove adapter-generated `--append-system-prompt` from RPC argv. Append supplementary adapter instructions to the already-rendered `event.systemPrompt` in `before_agent_start`. Preserve user prompt resources, project trust decisions, other extensions' prompt changes, and new/resumed behavior without reimplementing Pi resource discovery.

## Compatibility and limits

Pi `1.1.0` is the supported minimum and current tested release. Its awaited before-settlement handling, boundary drafts and rendered-prompt supplementation are available, but custom notifications queued during an awaited handler have no public live queue signal. Do not rely on an unavailable boundary `ctx.signal`; adapter owner-cancel control must wake the handler before native abort waits for it. The approved probes bridge the queue gap; their extra provider calls, timing and non-success deadline behavior must be demonstrated and documented. No support claim is made for Pi below `1.1.0`.

Validate the user's actual clean git-main `pi-subagents` checkout at `29284cd943c0c7ee852593c6e02d2a60febf6ba4`, loaded through its declared `index.ts` entry. Its `0.77.0` package label is not proof of equivalence with the published npm artifact. Record exact revision, clean source status, loaded entry and public capabilities; revalidate after runtime checks. Historical package compatibility is outside this task: remove the old-version evaluation matrix and explicitly retarget cancellation evidence to this same git revision. Do not modify or update the installed runner. Missing structured notification or exhaustive status evidence still fails visibly, without adopting or stopping foreign work.

Bounded snapshots may not prove an arbitrary descendant tree. Missing roots, truncation, ambiguous ancestry, or unattributable omissions produce an explicit limitation, not success. This design does not promise universal runner support, semantic correctness of the model's final answer, or a proven fix in the user's installed Zed.

## Scope

Likely code: `src/pi-rpc/acp-extension.ts`, `src/pi-rpc/process.ts`, `src/pi-rpc/version.ts`; touch `src/acp/session.ts` only for a demonstrated lifecycle/error attribution need. Keep existing layers and avoid dependencies or new generic frameworks.

Tests/callers: extension and version unit tests; background, native-admission, responsiveness and cancellation component suites; scripted real-Pi eval and fixtures. Update README and stale `docs/zed-acp-audit.md` claims. The new detach tool must be exercised through real Pi's schema/dispatch path, not just a fake registration.

## Acceptance evidence

- Required root + deliberately early parent yield: ACP prompt remains open through exact completion notice consumption and final parent response.
- Explicit detach: prompt returns promptly; subsequent prompt/cancel does not adopt, wait for, or stop that work.
- Mixed and foreign work: only required captured roots affect completion; cancellation never uses aggregate unrelated liveness as its predicate.
- Fast completion, wake during boundary, partial deliveries, new roots from synthesis, final text preceding delivery, duplicate/stale notices, and queued supervisor work have correct ordering and no spin loop.
- Terminal root/live descendant, malformed or omitted snapshots, missing metadata, runner failure, delivery deadline, owner/session replacement and cancel race do not become successful drain.
- APPEND_SYSTEM content and adapter policy both reach a deterministic provider, including resumed sessions; argv does not suppress discovery.
- Formatting, typecheck, lint, full tests, build, ACP smoke, and representative deterministic real-Pi eval pass on Pi `1.1.0`. Explicitly exercise a fast provider with a notice queued after a probe, partial deliveries while another root remains running, probe rate/count/deadline bounds, and genuine draft validation. Acquire fixture runtimes only in disposable temporary directories, without changing project dependencies or host configuration.
- Fresh full-mode reviewers inspect actual changed source, with actual model/effort/family recorded. Parent accepts findings; one fix worker applies accepted scope and material fixes receive targeted re-review.

## Builder decisions

Choose the smallest local state representation and public context/turn event bookkeeping that prove the ordering above. Reuse existing validators and error transactions where correct. Decide routine reversible implementation details without expanding scope. Escalate missing public observations, incompatible floor behavior, or any need for runner/client/FIFO changes before implementation proceeds.
