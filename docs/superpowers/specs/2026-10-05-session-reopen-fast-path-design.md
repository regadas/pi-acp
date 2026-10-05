# Session reopen fast path

## Intent

Make `pi-acp` reopen an existing session without enumerating every Pi session file when its durable ID-to-file record is valid. Keep ID-only `session/prompt`, `session/resume`, and `session/load` working after an adapter restart. Preserve discovery for records the adapter has never seen or can no longer use. No new database or persistent index.

## Current behavior and comparison

`SessionRepository.find()` reads the stored ID-to-path record, then still enumerates the containing session directories and reads each JSONL header to select the newest duplicate. Concurrency reduces wall time but does not remove this linear work. Pi's own `pi --session <id>` also scans headers in the current project and may fall back to full cross-project listings; passing the ID instead of a path merely moves that scan into Pi. Pi's `--session-id` can create a missing session and is not a safe replacement for restore. `pi-acp` already spawns Pi with `--session <path>` and checks Pi's reported session ID and file before installing it.

Codex delegates ID lookup to its backend state DB. Pi has no equivalent indexed ID resolver; the adapter's existing `SessionStore` record is the closest available fast locator.

## Design

1. On `find(id, cwd?)`, check the per-ID stored path first. Validate its JSONL header against the requested ID and use the header's recorded cwd, retaining the caller's existing cwd check. A valid file is returned without enumerating directories or scanning transcript metadata; restore only needs cwd and path.
2. If no stored record exists or its file is missing/invalid, retain the current discovery scan and repair the per-ID record after finding the appropriate file. Corrupt `SessionStore` records and resource-exhaustion errors remain visible rather than being silently treated as misses. Never let an absent/mismatched file cause Pi to create a new session under the requested ID.
3. Keep `session/list`'s explicit discovery and metadata gathering, but prefer the validated mapped file when deduplicating the same ID so listing and reopening agree. Keep `session/delete`'s duplicate-file cleanup and all close/delete and process-replacement barriers intact.
4. On a valid mapping, treat its file as the canonical session. This intentionally changes the previous behavior where a newer duplicate with the same ID could silently replace a still-valid mapping during every reopen. Discovery continues to choose the newest candidate when the mapping is missing or invalid. This trade-off is necessary for a constant-work mapped lookup without a file watcher or a Pi-owned database; default UUID collisions are negligible, while file copies or caller-chosen IDs can create duplicates intentionally.

## Boundaries and verification

Target `src/acp/session-repository.ts` and focused repository tests; touch the adapter restore path only if the existing `find` return contract cannot preserve the behavior above. Tests should prove no directory enumeration or transcript metadata scan for a valid mapping, header ID/cwd validation, fallback discovery and repair for missing or invalid mappings, and consistent mapped-file selection in list/reopen plus safe duplicate deletion. Run focused tests, build/type checks, broader relevant tests, and formatting before fresh read-only review. Do not commit or change unrelated files.

Success means mapped reopen lookup cost no longer grows with the number of Pi session files; cold discovery and explicit listing may still grow with directory size. Spawning Pi and loading the requested session remain separate latency costs, not claimed fixed by this change.
