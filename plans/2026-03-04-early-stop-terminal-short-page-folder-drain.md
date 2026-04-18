# Plan: Early stop on terminal short page in folder drain sync

**Status:** Complete
**Created:** 2026-03-04
**Source:** ~/.claude/plans/quirky-whistling-floyd.md
**Version:** 3.0

## Context

When a folder sync fetches a short page (<20 tweets), stores it, then deletes it successfully, the next page fetch is often unnecessary. In drain mode this previously showed up as a wasted final empty fetch after rate-limit pauses. The same signal also matters when `--pages N` is set: if the folder already looks exhausted, additional capped pages are still wasted work.

The Twitter folder endpoint does not reliably signal exhaustion via `nextToken`, so we cannot use pagination state. Instead we use a heuristic: if a folder page fetched >0 but <20 tweets and **all** were successfully deleted with zero failures, the folder is treated as drained and we can stop immediately.

## Constraints

- **Folder-only**: Gate on `isFolderSync` — don't apply to non-folder sync paths
- **Delete-success required**:
  - Early-stop only when current-page deletes are fully successful (`newDeleted === totalFetched`, `newDeleteFailed === 0`)
  - If **all** deletes fail, existing `no-progress` safety valve applies
  - If deletes are **partially** successful, do not early-stop; continue with existing loop behavior
- **Compatible stop reason**: Reuse `'empty'` — no new `SyncStopReason` variant
- **Shared code**: `executePagedSync` / `resolvePostPageStopReason` are shared; both Temporal and local paths benefit
- **Cap-compatible**: `--pages N` is treated as an upper bound, not a promise to fetch more pages after a strong exhausted-folder signal

## Changes

### 1. Add `isFolderSync` to page loop params

**`src/lib/sync-runner/types.ts`** — `ExecutePagedSyncParams`

- Add `isFolderSync: boolean`

### 2. Thread `isFolderSync` to stop-reason check

**`src/lib/sync-runner/page-loop.ts`** — `executePagedSync()`

- Pass `isFolderSync: params.isFolderSync` to `resolvePostPageStopReason`

### 3. Add named constant and terminal-short-page heuristic

**`src/lib/sync-runner/stop-reason.ts`** — `resolvePostPageStopReason()`

- Export a named constant:

  ```ts
  /**
   * Twitter folder endpoints return up to this many items per request.
   * A response with fewer items signals the folder is exhausted.
   * See: folder endpoint does not reliably set nextToken on final page.
   */
  export const FOLDER_ENDPOINT_PAGE_CAP = 20;
  ```

- Add `isFolderSync: boolean` to the input
- **After** existing checks (empty, no-progress), add:

  ```text
  if (isFolderSync && !noDelete &&
      totalFetched > 0 && totalFetched < FOLDER_ENDPOINT_PAGE_CAP &&
      newDeleted === totalFetched && newDeleteFailed === 0)
    → return 'empty'
  ```

### 4. Pass `isFolderSync` from callers

**`src/temporal/workflows/sync/page-runner.ts`** — `runSyncPages()`

- Derive `isFolderSync` from `workflowInput.folderId` and `workflowInput.noFolders` (same logic as `resolvePageLimit`)
- Pass it in the `executePagedSync` call

**`src/commands/sync/bookmarks/local/run.ts`** — `runLocalSync()`

- Derive `isFolderSync` from `options.folderId` and `options.noFolders`
- Pass it in the `executePagedSync` call

### 5. Tests

**`tests/temporal-sync-workflow.test.ts`**

Update existing multi-page folder test ("loops pages and aggregates results across cycles"):

- Scenario: page 1 fetches 20 tweets (full page, must continue), page 2 fetches 5 tweets (short, all deleted → early exit)
- Expect **2 fetch calls** (no third empty-fetch cycle)

Add negative tests:

- **`fetched === 20`**: 20 tweets fetched and all deleted → must NOT early-exit, continue to next page
- **Short page with partial delete failures**: fetch <20, some deletes succeed and some fail → must NOT early-exit
- **Short page with total delete failure**: fetch <20, all deletes fail → must return `'no-progress'` (existing safety valve)
- **Short page with explicit `--pages N`**: fetch <20 and all deleted → should early-exit without consuming remaining page budget
- **`--no-delete` mode**: fetch <20 → must NOT early-exit (no deletes happening, can't infer drained)
- **Non-folder sync**: fetch <20 from non-folder endpoint → must NOT early-exit

**New test file: `tests/stop-reason.test.ts`** (required)

- Direct unit tests for `resolvePostPageStopReason` with the new `isFolderSync` param:
  - `isFolderSync=true`, short page, all deleted → returns `'empty'`
  - `isFolderSync=true`, full page (=== 20), all deleted → returns `undefined`
  - `isFolderSync=true`, short page, partial delete failures (`newDeleted > 0`, `newDeleteFailed > 0`) → returns `undefined`
  - `isFolderSync=true`, short page, all deletes fail (`newDeleted === 0`, `newDeleteFailed > 0`) → returns `'no-progress'`
  - `isFolderSync=false`, short page, all deleted → returns `undefined`
  - `noDelete=true`, short page → returns `undefined`
  - Existing cases (empty, no-progress) still work with `isFolderSync=false`

## Files touched

| File | Change |
| --- | --- |
| `src/lib/sync-runner/types.ts` | Add `isFolderSync` to params |
| `src/lib/sync-runner/page-loop.ts` | Forward `isFolderSync` |
| `src/lib/sync-runner/stop-reason.ts` | Add constant + heuristic |
| `src/temporal/workflows/sync/page-runner.ts` | Derive + pass `isFolderSync` |
| `src/commands/sync/bookmarks/local/run.ts` | Derive + pass `isFolderSync` |
| `tests/temporal-sync-workflow.test.ts` | Update drain test, add negatives |
| `tests/stop-reason.test.ts` | New: unit tests for heuristic |

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm test` — all existing + new tests pass
3. Manual: run a folder drain sync with a small folder (<20 bookmarks), confirm it stops without the extra empty-fetch cycle

## Notes

- Implemented on 2026-03-05.
- The heuristic now applies to **folder sync generally**, including explicit `--pages N` runs, because a successful short page is treated as a stronger exhausted-folder signal than any remaining page budget.
