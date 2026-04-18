# Plan: Add `--pages` option for folder sync

**Status**: Complete (2026-02-13)

## Context

The X API folder bookmarks endpoint (`GET /2/users/:id/bookmarks/folders/:folder_id`) has no pagination support — it returns a hard-capped 20 items per request with no `next_token` (documented in `docs/issues/folder-pagination.md`, problem 2). The only way to access more than 20 bookmarks in a folder is delete cycling: fetch 20 → store → delete → fetch again to get the next 20.

Currently, each sync invocation processes exactly one page (~20 items). A folder with 4000 bookmarks requires 200 separate `sync` runs. The `--pages` flag lets users run N fetch→store→delete cycles in a single invocation.

## Design

**The SyncEngine doesn't change.** The page loop lives in the callers (CLI command + Temporal workflow). Each page creates a fresh `SyncEngine` instance, runs it, and aggregates results. The `CliSyncOperations` adapter is stateless and shared across cycles.

```text
backlog phase (first cycle only)
for page 1..N:
  SyncEngine.run():
    fetch ~20 IDs
    store to SQLite
    process (delete each from X)
  break if 0 items fetched (folder drained)
```

### Validation rules

- `--pages` requires a folder-id (meaningless without folder sync)
- `--pages` requires delete enabled (incompatible with `--no-delete` — can't cycle without deleting)
- `--pages` incompatible with `--dry-run`
- `--pages` and `--limit` remain independent (`--limit` stays rejected for folder sync)

### Early exit

If a page cycle fetches 0 items, stop looping — the folder is drained. This makes `--pages 999` safe as a "drain the whole folder" idiom.

## Changes

### 1. CLI option + validation — `src/commands/sync.ts`

- Add `.option('-p, --pages <count>', 'Number of page cycles for folder sync')`
- Parse to number, add to `SyncBookmarksOptions` interface
- Validation: reject if `pages` set without `folderId`, with `--no-delete`, or with `--dry-run`
- Wrap engine creation + `engine.run()` in a `for` loop when `pages > 1`
- Aggregate `SyncResult` across cycles (sum counters)
- First cycle: let backlog phase run normally; subsequent cycles: backlog is naturally empty
- Display per-page progress: `Page 1/N`, `Page 2/N`, etc.
- Break loop if `result.totalFetched === 0`

### 2. Temporal workflow input — `src/temporal/shared/types.ts`

- Add `pages?: number` to `SyncWorkflowInput`

### 3. Temporal workflow — `src/temporal/workflows/sync.ts`

- When `input.pages` is set, loop engine creation + `engine.run()` for N iterations
- Deterministic: loop count comes from workflow input, early break on `totalFetched === 0` replays correctly
- Aggregate `SyncResult` fields across cycles into workflow-level counters
- Child enrich workflow starts once after all page cycles complete (if any stubs)

### 4. Tests — `tests/sync-engine-pages.test.ts` (new file)

Follow patterns from `tests/sync-engine-decouple.test.ts`:

- Use `createOps()` helper with `vi.fn()` mocks
- Test: 3-page cycle with fresh engine per page, verify `fetchBookmarks` called 3 times, `deleteBookmark` called for each item
- Test: early exit when fetch returns 0 items (page 2 returns empty → only 1 cycle runs)
- Test: result aggregation across pages (sum of newBookmarks, newDeleted, etc.)

### 5. Workflow test — `tests/temporal-sync-workflow.test.ts`

- Add test for `pages` input flowing through the workflow loop

## Files to modify

| File | Change |
| --- | --- |
| `src/commands/sync.ts` | Add `--pages` option, validation, page loop with result aggregation |
| `src/temporal/shared/types.ts` | Add `pages` to `SyncWorkflowInput` |
| `src/temporal/workflows/sync.ts` | Page loop around engine creation |
| `tests/sync-engine-pages.test.ts` | New: page cycling tests |
| `tests/temporal-sync-workflow.test.ts` | Add pages test case |

## Implementation notes

### Temporal workflow callback counter double-counting (resolved)

The original single-page workflow used callbacks that **assigned** progress counters:

```ts
onFetched: (_count, total) => { fetched = total; }
onStored: (result) => { stored = result.newBookmarks + result.updatedBookmarks; }
onDeleted: (_tweetId, success) => { if (success) deleted++; }
```

The first naive multi-page implementation added `fetched += result.totalFetched` after each `engine.run()`, which **double-counted** because:
- `onFetched` already set `fetched = total` (per-engine total, not cumulative)
- `onDeleted` already incremented `deleted++` (naturally additive)
- The post-run aggregation then added on top of the callback values

The fix uses **page offsets** for assignment-style callbacks (`onFetched`, `onStored`) so they produce cumulative values across pages, while `onDeleted` (already incremental) works as-is. The post-run code only aggregates fields the callbacks don't track (`totalNewRecords`, `totalStubsForEnrichment`).

```ts
let fetchedPageOffset = 0;
let storedPageOffset = 0;

// In callbacks:
onFetched: (_count, total) => { fetched = fetchedPageOffset + total; }

// After each engine.run():
fetchedPageOffset = fetched;
storedPageOffset = stored;
```

This keeps progress queries accurate mid-page (callbacks fire during execution) while accumulating correctly across pages.

### CLI approach is simpler

The CLI doesn't have this problem — it constructs a standalone `aggregated: SyncResult` object and sums fields from each `engine.run()` result. Callbacks are display-only in the CLI (they write to console, not to counters used in the return value).

### Additional test added

`tests/sync-engine-pages.test.ts` includes a backlog test confirming that `getDeleteBacklog` is called on every page (not skipped after page 1). The backlog is naturally empty after the first cycle since all pending deletes were cleared, but the engine still checks — this is a redundant query, not a bug.

### Documentation delivered alongside

- ADR 021 created
- ADR 006 updated with `--pages` note
- ADR README index updated
- `docs/issues/folder-pagination.md` workaround section updated with `--pages` examples
- README options table and folder sync note updated
- CLAUDE.md workflow commands and SyncWorkflow description updated

## Verification

```bash
pnpm typecheck                        # Types compile
pnpm test                             # All tests pass (139/139)
pnpm lint                             # Clean

# Manual: local folder sync with pages
pnpm dev sync <folder-id> --local --pages 3

# Manual: Temporal workflow
pnpm dev sync <folder-id> --pages 3
pnpm dev workflow status <id> --watch
```

## Post-Implementation Critique (2026-02-13)

### Findings (ordered by severity)

1. **Medium: incorrect "Pages completed" summary in CLI output**
   - File: `src/commands/sync.ts` (`Pages completed` line in summary block)
   - The summary currently prints:
     - `Math.min(totalPages, Math.max(1, totalPages))`
   - This always resolves to `totalPages`, even when the loop exits early because the folder is drained.
   - User impact: inaccurate run reporting for large drains (`--pages 999` may report 999 pages completed even if only a few ran).

2. **Medium: validation invariants live only in one entrypoint**
   - Files: `src/commands/sync.ts`, `src/temporal/workflows/sync.ts`
   - `sync` command enforces `--pages` rules (folder required, no-delete/dry-run incompatible), but the workflow itself does not validate `input.pages`.
   - Risk: other workflow launch paths (SDK/tests/future CLI changes) can bypass these constraints and produce undefined behavior (e.g., `pages <= 0` becomes a silent no-op).

3. **Low: permissive numeric parsing for `--pages`**
   - File: `src/commands/sync.ts`
   - `Number.parseInt` accepts partial numeric strings (`3abc` => `3`, `1.9` => `1`).
   - Risk: surprising acceptance of malformed input.

4. **Low: test coverage misses command-level behavior**
   - Files: `tests/sync-engine-pages.test.ts`, `src/commands/sync.ts`
   - The new page tests validate a recreated loop around `SyncEngine`, but do not directly test the real CLI page loop/reporting.
   - Result: the summary-reporting bug above is not caught.

### Actionable Fix List

- [x] Add a `pagesCompleted` counter in `src/commands/sync.ts`:
  - increment after each successful `engine.run()`
  - print actual completed count in summary
  - optionally print `requested vs completed` for clarity
- [x] Add shared validation for page-cycling invariants:
  - extract to a helper (e.g., `validateSyncPagingOptions(...)`)
  - use it in both `sync` command path and Temporal workflow entry (`syncWorkflow`) as a defensive guard
- [x] Replace permissive `parseInt` parsing with strict positive-integer parsing (`Number(...)` + `Number.isInteger(...)` + range check or regex)
- [x] Add caller-level tests:
  - CLI: early-exit run should report actual pages completed
  - Workflow: reject invalid `pages` inputs (`0`, negative, non-integer) and incompatible combinations if present
  - Keep `sync-engine-pages` tests, but treat them as engine-loop behavior examples, not command-integration coverage
