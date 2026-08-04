# Plan: Drain-by-Default Folder Sync

## Context

The X API folder endpoint returns max 20 bookmark IDs per request with no pagination token. The only way to access older bookmarks is to delete the visible ones, revealing the next batch. Currently `--pages N` enables page cycling; without it, the default is 1 page. Users use `--pages 999` as a workaround for "drain everything." The natural default for folder sync should be drain-until-empty.

**Cancel recovery** is already handled: `enqueuePendingDeletes()` in the backlog phase seeds the delete queue from all bookmarks where `deleted_from_x = 0`. A cancelled sync's un-deleted bookmarks are automatically picked up on the next run's backlog phase (within page 1, before fetch). No changes needed.

## Behavior Matrix

| Command | Current | New |
| --- | --- | --- |
| `sync <folder-id>` | 1 page | **Drain until empty** |
| `sync <folder-id> --pages 10` | 10 pages | 10 pages (cap) |
| `sync --no-folders` | 1 page (follows API pagination tokens) | 1 page (unchanged) |
| `sync <folder-id> --no-delete` | 1 page | 1 page (unchanged) |
| `sync <folder-id> --dry-run` | 1 page | 1 page (unchanged) |

## Changes

### 1. Add `resolvePageLimit()` — `src/lib/sync-pages.ts`

New pure function that centralizes drain-vs-cap logic for both callers:

```typescript
export interface ResolvedPageLimit {
  maxPages: number | undefined; // undefined = unlimited (drain)
  isDrain: boolean;
}

export function resolvePageLimit(input: {
  pages: number | undefined;
  folderId: string | null | undefined;
  noFolders: boolean;
  noDelete: boolean;
  dryRun: boolean;
}): ResolvedPageLimit
```

Logic: explicit `--pages` wins → folder sync with deletes enabled → drain (unlimited) → else 1 page.

No changes to existing `validateSyncPagingOptions` — it still validates the explicit `--pages` flag.

### 2. Add types — `src/temporal/shared/types.ts`

- `SyncWorkflowResult`: add `stopReason?: 'empty' | 'no-progress' | 'page-limit' | 'cancelled'`
- `SyncProgress`: add `page?: number` and `pageLimit?: number` (undefined = drain)

### 3. Refactor page loop — `src/temporal/workflows/sync.ts`

Replace `for (let page = 1; page <= totalPages; page++)` with `while (true)` loop:

- Call `resolvePageLimit()` to derive `maxPages` and `isDrain`
- Track `page` counter, `stopReason`
- Break conditions: `isCancelled` → cancelled, `page > maxPages` → page-limit, `totalFetched === 0` → empty, no-progress check → no-progress
- Add `page`/`pageLimit` to progress query handler
- Add `stopReason` to return value

**No-progress safety valve**: after each page, if `!noDelete && totalFetched > 0 && (backlogDeleted + newDeleted) === 0`, break with `stopReason: 'no-progress'`. Prevents infinite loop when deletes consistently fail.

### 4. Refactor page loop — `src/commands/sync.ts`

Mirror the same `while (true)` + `resolvePageLimit()` pattern for the local `--local` path:

- Replace `const totalPages = pages ?? 1` (line 334) and the `for` loop (line 357)
- Update section headers: `Page N` for drain, `Page N/M` for capped
- Add `stopReason` to summary display

### 5. Update display — `src/commands/sync.ts` + `src/commands/workflow.ts`

**Startup display** (both sync command and `workflow start sync`):

- When `pages` is set: `Pages: N (cap)`
- When drain: `Pages: drain (until empty)`

**workflow status** display (workflow.ts ~line 358): add page tracking line:

```text
Page: 3 (drain)    — or —    Page: 3/10
```

**Sync summary** (sync.ts ~line 422): update pages completed display and add stop reason.

### 6. Tests

**`tests/sync-pages.test.ts`** — add `resolvePageLimit` tests:

- Drain by default for folder sync with deletes
- Explicit pages as cap
- 1 page for `--no-delete`, `--dry-run`, `--no-folders`, no folderId

**`tests/sync-engine-pages.test.ts`** — add no-progress safety valve test:

- Fetch returns items but all deletes fail → loop stops after 1 page

**`tests/temporal-sync-workflow.test.ts`** — add:

- Drain mode test (no `--pages`, folder sync → loops until empty)
- No-progress safety valve test
- `stopReason: 'page-limit'` test
- Progress query includes `page`/`pageLimit`
- Update existing tests that check result shape to include `stopReason`

### 7. Docs

**`CLAUDE.md`** — replace:

```text
pnpm dev sync <folder-id> --pages 10       # 10 page cycles (~200 bookmarks)
pnpm dev sync <folder-id> --pages 999      # Drain folder (exits on empty)
```

with:

```text
pnpm dev sync <folder-id>                  # Drain folder (loops until empty)
pnpm dev sync <folder-id> --pages 10       # Cap at 10 page cycles (~200 bookmarks)
```

**`docs/adr/025-drain-by-default-folder-sync.md`** — new ADR documenting:

- Context: `--pages 999` is the common case; drain is the natural default
- Decision: folder sync drains by default; `--pages` becomes safety cap
- `resolvePageLimit` centralizes logic; no-progress safety valve
- Amends ADR 023

## Files Modified

| File | Change |
| --- | --- |
| `src/lib/sync-pages.ts` | Add `resolvePageLimit()` |
| `src/temporal/shared/types.ts` | Add `stopReason`, `page`, `pageLimit` |
| `src/temporal/workflows/sync.ts` | Refactor page loop to `while`, add drain/safety |
| `src/commands/sync.ts` | Mirror loop refactor for local path, update display |
| `src/commands/workflow.ts` | Update startup + status display for page/drain |
| `tests/sync-pages.test.ts` | Add `resolvePageLimit` tests |
| `tests/sync-engine-pages.test.ts` | Add no-progress safety valve test |
| `tests/temporal-sync-workflow.test.ts` | Add drain, safety valve, stopReason tests |
| `CLAUDE.md` | Update usage examples |
| `docs/adr/025-drain-by-default-folder-sync.md` | New ADR |

## Verification

1. `pnpm typecheck` — clean
2. `pnpm lint` — clean
3. `pnpm test` — all pass including new tests
4. Manual: `pnpm dev sync <folder-id> --local` drains until empty
5. Manual: `pnpm dev sync <folder-id> --pages 2 --local` stops after 2 pages
6. Manual: `pnpm dev sync --no-folders --local` runs single page (unchanged)
