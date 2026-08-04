# Plan: Interleave Enrich + Delete Per Item

## Context

The sync engine currently runs enrichment and deletion as separate batch phases:
**fetch → store → enrich ALL stubs → delete ALL tweets**. This was designed for the
old free-tier rate limits and potential alternative data sources (bird GraphQL). With
pay-per-usage (900 enrichments/15min, 50 deletes/15min), the batch separation adds
complexity without benefit. The goal: merge into a single per-item loop so every tweet
is enriched immediately before its delete fires, eliminating the window where stubs
sit in the delete queue without full data.

## Changes

### 1. Add `'process'` phase to SyncPhase types

**Files:**

- `src/lib/sync-engine.ts` (line 20) — add `'process'` to union
- `src/temporal/shared/types.ts` (line 46, 51) — add `'process'` to both `SyncWorkflowError.phase` and `SyncPhase`

Keep `'enrich'` and `'delete'` values (backlog phase still uses delete semantics).

### 2. Replace `runEnrichPhase()` + `runDeletePhase()` + `queueDeletes()` with `runProcessPhase()`

**File:** `src/lib/sync-engine.ts`

New method iterates `this.allTweets` once:

```text
for each tweet:
  if stub && !noEnrich: enrichWithRetry() → track success/failure
  if noDelete: enqueueDelete() → continue
  if stub && enrich failed: enqueueDelete() + warning → continue (safety gate)
  deleteWithRetry() → markBookmarkDeleted or recordDeleteFailure
```

Key behaviors per mode:

| Mode | Enrich? | Delete? |
| --- | --- | --- |
| Normal folder sync (stubs) | Yes → then delete | Yes |
| Normal global sync (full data) | Skipped (not stub) | Yes |
| `--no-delete` | Yes (if stub) | No — enqueueDelete |
| `--no-enrich` | Skipped | Yes (stubs go straight to delete) |
| `--no-enrich --no-delete` | Skipped | No — enqueueDelete |
| Dry run | Never reached | Never reached |

Remove `runEnrichPhase()`, `runDeletePhase()`, and `queueDeletes()`.

### 3. Simplify `runSingleCycle()`

**File:** `src/lib/sync-engine.ts` (lines 272-311)

Replace the separate conditional calls with:

```text
backlog (if !noDelete, first cycle only)
fetch
store
if allTweets.length > 0: runProcessPhase()
```

All mode branching (`noDelete`, `noEnrich`, `stubTweets > 0`) moves inside `runProcessPhase()`.

### 4. Update CLI phase display

**File:** `src/commands/sync.ts` (line 214-231)

Add `case 'process'` to `onPhaseStart` switch → `phaseHeader(3, 'Processing bookmarks')`.
Update `onStored` message (line 249): "will be enriched in next phase" → "will be enriched".

### 5. Update Temporal workflow callbacks

**File:** `src/temporal/workflows/sync.ts` (lines 280-292)

Handle `'process'` in `onPhaseStart` — set both `totalToEnrich` and `totalToDelete`.
Update the phase-clearing guard to include `'process'`.

### 6. Update tests

**`tests/sync-engine-enrich.test.ts`** — Tests currently use `noDelete: true`. With the
new flow, `runProcessPhase()` handles `noDelete` by calling `enqueueDelete`. Most tests
pass as-is since `enrichRecord` mock calls are unchanged. Add assertions for `enqueueDelete`
being called. Update describe block name.

**`tests/sync-engine-drain.test.ts`** — Safety gate test (line 122) works unchanged:
stub with failed enrichment → `enqueueDelete` called, `deleteBookmark` not called.

**`tests/sync-engine-retry.test.ts`** — Tests use stubs `{ id: 't1' }` without `_fullJson`.
With interleaving, `enrichRecord` is called before `deleteBookmark`. Default mock returns
`{ success: true }` so tests pass, but `enrichRecord` call count increases. Tests at lines
66, 91, 146 need `noEnrich: true` added to options OR fixtures changed to full tweets, to
keep them focused on delete retry behavior.

**`tests/sync-engine-resume.test.ts`** — Uses `noDelete: true`, should work as-is.

### 7. Write ADR 019

**File:** `docs/adr/019-interleaved-enrich-delete.md`

Document the decision, rationale (every delete carries maximum data value), and that
the SyncOperations interface is unchanged.

## Files to modify

1. `src/lib/sync-engine.ts` — core change
2. `src/temporal/shared/types.ts` — type update
3. `src/temporal/workflows/sync.ts` — callback update
4. `src/commands/sync.ts` — CLI display update
5. `tests/sync-engine-enrich.test.ts` — test updates
6. `tests/sync-engine-retry.test.ts` — add `noEnrich: true` to delete-focused tests
7. `docs/adr/019-interleaved-enrich-delete.md` — new ADR

## What does NOT change

- `SyncOperations` interface — no new methods, no changed signatures
- `CliSyncOperations` adapter — untouched
- Temporal activities (`store.ts`, `delete.ts`, `fetch.ts`) — untouched
- `SyncResult` counters — same fields, same semantics
- Backlog phase — unchanged (already does verify→delete per item)
- `enrichWithRetry()` / `deleteWithRetry()` — unchanged
- `resetCycleState()` — unchanged (still clears `enrichFailedIds`)

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm test` — all tests pass
3. `pnpm lint` — no lint errors
4. Manual: `pnpm dev sync --local --no-folders --dry-run` — fetch works, no store/process
5. Manual: `pnpm dev sync --local <folder-id> --no-delete` — stubs enriched, enqueued
6. Manual: `pnpm dev sync --local <folder-id>` — stubs enriched then deleted per-item
