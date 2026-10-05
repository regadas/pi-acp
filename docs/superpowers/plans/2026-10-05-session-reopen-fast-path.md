# Session Reopen Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reopen mapped Pi sessions without enumerating session directories, while keeping list/reopen consistent for duplicate IDs.

**Architecture:** `SessionRepository.find()` validates and returns the stored file before discovery. An unusable mapping falls back to the existing scan and repairs the mapping. `list()` still discovers all sessions but prefers a validated stored file when deduplicating its ID.

**Tech Stack:** TypeScript, Node.js filesystem APIs, `node:test`, Prettier.

**Spec:** [session-reopen-fast-path-design.md](../specs/2026-10-05-session-reopen-fast-path-design.md)

## Global Constraints

- No new persistent database, index, or dependency; reuse `SessionStore` and `validatedHeader`.
- Preserve cold discovery, ID/cwd validation, resource-exhaustion errors, safe duplicate deletion, and process replacement barriers.
- Keep source changes in `src/acp/session-repository.ts` and focused tests in `test/unit/session-repository.test.ts` unless an existing contract demonstrably requires more.
- Do not commit; format touched files narrowly and verify before finishing.

## Review Focus

1. Valid mapping amid many unrelated files: `find` must not enumerate directories or scan metadata (Task 1 test).
2. Mapping points at another ID or a missing file: fallback must discover/repair the right file, not open a new empty session (Task 1 test).
3. Mapping has a matching ID but different header cwd from its stored metadata: use the header's cwd so the caller's cwd check cannot be bypassed (Task 1 test).
4. Mapped older duplicate and newer copy: list and find must agree on the mapped file; delete still removes both (Task 1 test).
5. `EMFILE` while reading the mapped file: propagate rather than silently treating it as a miss (Task 1 test).

---

### Task 1: Make mapped sessions canonical without scanning on reopen

**Files:**

- Modify: `src/acp/session-repository.ts` (`find`, `list`)
- Test: `test/unit/session-repository.test.ts`

**Interfaces:**

- Consumes: `SessionStore.get/list/upsert`, `validatedHeader(path, requestedId)`, `matchingRecords(id, cwd)`.
- Produces: unchanged `find(id, cwd?): Promise<SessionRecord | null>` and `list(cwd?): Promise<SessionRecord[]>` signatures.

- [ ] **Step 1: Add failing tests.** For a valid stored file, spy on directory enumeration and `createReadStream`; assert `find(id, cwd)` returns the mapped path/header cwd with neither scan. Assert a stored older duplicate wins both `find` and `list`, while `delete` removes both. Assert a missing/mismatched mapped file falls back to a valid discovered file and repairs `store.get(id)`; assert header cwd supersedes stale stored cwd. Assert a mapped-file `EMFILE` propagates.
- [ ] **Step 2: Run focused tests red.** `node --import tsx --test test/unit/session-repository.test.ts` must fail on the new assertions before the implementation change.
- [ ] **Step 3: Implement minimal fast path.** In `find`, keep the existing custom-store test seam; for production stored entries validate only the mapped header, return the header cwd/path with stored timestamp and no metadata scan, otherwise use the existing `matchingRecords`/newest fallback and `upsert`. In `list`, use `store.list()`'s ID→path entries when selecting among validated duplicate records; prefer that path if present, otherwise preserve newest selection. Preserve existing cwd filtering and deletion behavior.
- [ ] **Step 4: Run focused tests green.** `node --import tsx --test test/unit/session-repository.test.ts` passes, including updated duplicate expectations and the new cases.
- [ ] **Step 5: Format and validate.** Run the narrow Prettier write command for changed files and the spec/plan, then `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Record any check that cannot run and why.
- [ ] **Step 6: Fresh review and accepted fixes.** Publish an immutable review bundle of the exact uncommitted changes, obtain fresh read-only correctness and lifecycle review seats, accept/reject findings against source/tests, apply accepted fixes once, rerun affected checks, and re-review material fixes. Do not commit.
