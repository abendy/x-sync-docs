# Task: Drain-by-Default Folder Sync

**Status:** Complete
**Completed:** 2026-02-14
**Created:** 2026-02-14
**Plan:** embedded (see ## Plan section below)
**Source:** ~/.claude/plans/reflective-tinkering-aurora.md

## ⚠️ Workflow Rules (do not remove)

- Use `/commit` after completing each chunk (not raw git commit)
- Mark completed tasks with `[x]` in this file after each chunk
- Generate chunk boundary report after each chunk
- Stop and wait for review after each chunk
- Do not batch work across chunks

## Chunks

### Chunk 1: Core Logic + Types + Workflow Refactor

- [x] Add `resolvePageLimit()` to `src/lib/sync-pages.ts` (plan §1)
- [x] Add `SyncStopReason`, `stopReason`, `page`, `pageLimit` to `src/temporal/shared/types.ts` (plan §2)
- [x] Refactor Temporal workflow page loop to `while(true)` + `resolvePageLimit()`, no-progress safety valve, `stopReason` (plan §3)

### Chunk 2: CLI Refactor + Display Updates

- [x] Refactor local CLI page loop in `src/commands/sync.ts` — mirror `while(true)` + `resolvePageLimit()` (plan §4)
- [x] Update startup + summary display in `src/commands/sync.ts` and `src/commands/workflow.ts` (plan §5)

### Chunk 3: Tests + Docs

- [x] Add `resolvePageLimit` tests in `tests/sync-pages.test.ts` (plan §6)
- [x] Add no-progress safety valve test in `tests/sync-engine-pages.test.ts` (plan §6)
- [x] Add drain, safety valve, stopReason, progress query tests in `tests/temporal-sync-workflow.test.ts` (plan §6)
- [x] Update `CLAUDE.md` usage examples and create ADR 025 (plan §7)

## Progress Log

### Session 1 - 2026-02-14

- All chunks implemented in single session
- Verification: typecheck clean, lint clean, 179 tests pass
- Commit: 42b626e feat(sync): drain folder by default instead of single page

## Chunk Boundary Report (All Chunks)

### Done

- feat(sync): drain folder by default instead of single page (42b626e)

### Files Changed

- `src/lib/sync-pages.ts` (modified) — added `resolvePageLimit()` + `ResolvedPageLimit`
- `src/temporal/shared/types.ts` (modified) — added `SyncStopReason`, `stopReason`, `page`, `pageLimit`
- `src/temporal/workflows/sync.ts` (modified) — refactored page loop to `while(true)` + drain logic
- `src/commands/sync.ts` (modified) — mirrored drain loop for local path, updated display
- `src/commands/workflow.ts` (modified) — updated startup + status display for drain/cap
- `tests/sync-pages.test.ts` (modified) — 6 new `resolvePageLimit` tests
- `tests/sync-engine-pages.test.ts` (modified) — 1 new no-progress safety valve test
- `tests/temporal-sync-workflow.test.ts` (modified) — 5 new tests (drain, no-progress, page-limit, progress query)
- `CLAUDE.md` (modified) — updated usage examples
- `docs/adr/025-drain-by-default-folder-sync.md` (new) — ADR documenting decision

### Context for Resumption

- `resolvePageLimit()` in `src/lib/sync-pages.ts:45` centralizes drain-vs-cap logic
- `SyncStopReason` type in `src/temporal/shared/types.ts:30`
- Both callers (workflow `sync.ts:415` and CLI `sync.ts:359`) use `while(true)` with break conditions
- No-progress safety valve checks `backlogDeleted + newDeleted === 0` after each page
- Progress query re-registered inside try block with `page`/`pageLimit` fields
- ADR 025 amends ADR 023

## Follow-up Review Action Items (2026-02-14)

1. [x] **[P2] Keep reported page within configured page limit**
   - **Issue:** In `src/temporal/workflows/sync.ts:419-427`, `currentPage` is incremented before the `maxPages` guard. For capped runs, state can transiently become `maxPages + 1` before the loop exits with `stopReason: 'page-limit'`.
   - **Impact:** During post-loop reconciliation (`getStubCount` / `startChild`) while status is still `RUNNING`, `progressQuery` can report invalid values (for example `2/1`) in `workflow status`.
   - **Action:** Move page increment/guard ordering so `progress.page` never exceeds `progress.pageLimit` for capped runs.
   - **Done when:** `workflow status` never shows impossible capped page ratios, including during reconciliation after a page-limit stop.
