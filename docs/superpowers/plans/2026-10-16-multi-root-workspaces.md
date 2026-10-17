# Multi-root Workspace Implementation Plan

> **For agentic workers:** Use the installed pi-subagents worker/review-loop recipes. The parent owns decisions and review acceptance; no nested agents or commits.

**Goal:** Make ACP multi-root workspaces usable in pi-acp, including root-scoped project instructions and correct session lifecycle reporting.

**Architecture:** Keep one pi process and one primary cwd per ACP session. Carry a validated, ordered additional-root list through session state, persistence, and subprocess startup. The existing adapter extension supplies a replaceable workspace-context section using pi's public prompt hook; primary-root native resource discovery remains unchanged.

**Tech Stack:** Existing TypeScript, Node/Bun, ACP SDK, pi RPC and adapter extension; no new dependencies.

**Spec:** User-approved scope in this conversation: paths plus project instructions; primary cwd/settings/extensions unchanged. This plan records the complete scope below.

## Global Constraints

- Support session/new, session/load, session/resume and session/list consistently; advertise `sessionCapabilities.additionalDirectories: {}` only with implementation complete.
- Additional roots are absolute existing directories, normalized/deduplicated against cwd and one another with stable first-occurrence order. Validate before lifecycle side effects.
- On load/resume, the request's roots replace the active roots; omitted and empty mean none. Do not resurrect previously stored roots implicitly.
- Additional roots contribute their own instruction file only, using native pi precedence: AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD. Do not walk their ancestors or load their settings/extensions.
- Expose every active workspace root and clearly label each additional root's instructions as applying within that root, not globally. Preserve native primary-cwd prompt context.
- Missing instruction files are allowed; real instruction-read failures must not silently drop requested context. Repeated turns must not duplicate context; changed/cleared roots must not leave old workspace context active.
- User-approved compatibility update after review: require pi >= 1.2.0, including version checks, CI/install references and current prerequisites. Published pi 1.1.0 supports mutable prompt sections but bypasses this hook on extension-triggered runs; 1.2.0 fixes that behavior. Preserve historical runtime receipts rather than relabeling them as 1.2.0 evidence.
- Persist/report ordered root metadata compatibly with old records. Ordinary repository refreshes must preserve it; sessions discovered without adapter metadata have no additional roots.
- Preserve session identity checks, cancellation/load generations, process retirement barriers and corruption handling. Changed-root resume must be serialized safely against load/close/prompt activity.
- No sandbox or access-control claim: this is workspace/model context, not filesystem enforcement.
- No commits, dependencies, unrelated refactors, settings changes, or automatic execution of additional-root resources.

## Review Focus

1. Root replacement on an already-live resume, including clearing roots and races with load/close.
2. Root metadata surviving list/find/upsert refresh and backward-compatible store parsing.
3. Canonical aliases, duplicate roots, invalid paths and validation-before-side-effects behavior.
4. Prompt scoping, native file precedence, no ancestor traversal, missing versus unreadable files, and repeated-turn freshness.
5. Child configuration isolation, primary cwd/resource discovery unchanged, supported pi-version compatibility.

## Ownership / Lane Board

| Lane                     | cwd                     | Contract / files                                                                                                  | Authority                               | Next gate                            | Why one writer                                                                                                                                                        |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspace-root lifecycle | current pi-acp checkout | root tuple carried across ACP agent, session manager/repository/store, pi process/extension, and their tests/docs | sole worker; approved target files only | focused tests, then npm run validate | One end-to-end session configuration seam: splitting root storage, live restore and prompt bridge creates overlapping ownership and artificial half-supported states. |

No parallel writers or worktrees are planned. Reviewers are read-only and fresh-context. This plan is protected from worker edits.

## Task 1: Deliver the complete workspace-root seam

**Files / responsibilities:**

- Add a small focused workspace-root/context helper only if needed; reuse existing cwd validation patterns.
- Modify src/acp/agent.ts: capability, preflight validation, new/load/resume root replacement, list projection.
- Modify src/acp/session-manager.ts, session.ts, session-repository.ts and session-store.ts: carry active roots and preserve compatible durable metadata.
- Modify src/pi-rpc/process.ts and acp-extension.ts: child-specific startup configuration and root-scoped prompt section using public pi hooks.
- Update relevant test/unit suites and test/fixtures/fake-pi-rpc.mjs only as needed; README.md documents behavior and limitations.

**Interfaces:** Use `additionalDirectories: string[]` internally after validation, optional metadata on legacy stored records. Primary `cwd` stays separate. Helper names/signatures are routine worker choices; no alternate public API is introduced.

- [ ] Inspect all callers and existing lifecycle ownership before editing. Read the recon artifact and relevant pi docs/API fully before changing the extension hook.
- [ ] Write and run red tests for valid-root acceptance/capability; invalid paths before spawn; ordered alias deduplication; root metadata round-trip/legacy records/refresh preservation.
- [ ] Implement the smallest shared validation and root-state pass-through that makes those tests pass.
- [ ] Write red tests for additional instruction-file precedence and scoping, no ancestor walk, missing/read-error handling, no duplicate prompt section across turns, and child config isolation.
- [ ] Implement the existing-extension prompt bridge without replacing native primary-root resources or changing cwd. Demonstrate actual hook mutation with the adapter-extension harness, not just environment assertions.
- [ ] Write red lifecycle tests for new/load/resume, live changed-root resume, empty/omitted clearing, unchanged-root reuse, list roots after refresh, and relevant load/close retirement ordering. Extend existing concurrency tests rather than redesigning lifecycle machinery.
- [ ] Complete lifecycle plumbing and README documentation. Preserve old single-root behavior when no extra roots are requested.
- [ ] Run focused tests through the isolated test runner (npm test -- --test-name-pattern=... as appropriate); run narrow formatting or npm run format only when safe, then npm run validate. Record exit codes and any unavailable runtime evidence.
- [ ] Return a durable handoff: changed paths, implementation decisions, red/green evidence, validation results, remaining limitations. Stop for parent decisions only on material ambiguity, scope/approval boundaries or concrete blockers.

## Review / Fix Delivery

Parent captures the exact uncommitted target and uses the local /review adapter's full-mode contract: fresh Sol correctness, Opus architecture/lifecycle, Sonnet tests, Gemini operability seats. All inspect actual source; parent verifies final model/effort/family, target stability and finding reachability. One fix worker addresses only accepted findings, reruns affected checks, and material fixes receive scoped follow-up review. Default maximum is three review rounds; unresolved/deferred findings are disclosed. No merge/release/commit authority is granted.
