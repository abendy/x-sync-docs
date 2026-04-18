# Decouple enrichment from sync — separate parallel process

**Status:** Complete

## Context

Sync currently interleaves enrichment and deletion per-tweet in its process phase. The tweet lookup endpoint (900 req/15min) sits idle while deletes trickle at 50/15min. With ~30% transient enrichment failures and a vision toward a permanent multi-source service, enrichment should run as an independent parallel process.

## Design

Remove all enrichment logic from the sync engine. Sync becomes: fetch → store → delete. After sync completes, the Temporal sync workflow fires off an independent EnrichWorkflow (which already exists) to fill in stubs. The two processes use separate API rate limit budgets.

**Key decision:** `wf.startChild(enrichWorkflow, { parentClosePolicy: ABANDON })` — the enrich workflow survives sync completion/cancellation, is visible as a child in Temporal UI, and requires no new activities or infrastructure.

## Files to modify

### 1. `src/lib/sync-engine.ts` — remove enrichment from engine

**Types:**

- `SyncPhase`: remove `'enrich'` from union
- Delete `EnrichRecordResult` interface (lines 45-50)
- `SyncCallbacks`: remove `onEnriched` callback
- `SyncResult`: remove `enriched` and `enrichFailed`, add `stubTweetsForEnrichment: number`
- `SyncOperations`: remove `enrichRecord` method

**Methods:**

- `runProcessPhase()` (line 430): remove enrichment block (lines 442-458), keep only delete/enqueue loop. Update progress message to remove enrichment count.
- Delete `enrichWithRetry()` (lines 490-504) entirely
- `runStorePhase()`: set `this.result.stubTweetsForEnrichment = storeResult.stubTweets`
- `run()` result initialization: remove `enriched: 0, enrichFailed: 0`, add `stubTweetsForEnrichment: 0`
- Update doc comment (lines 1-11): phase 4 becomes "Delete" not "Enrich then delete"

### 2. `src/temporal/shared/types.ts` — update shared types

- `SyncWorkflowResult`: keep `enriched` as `0` for backward compat (mark `@deprecated`), add `enrichWorkflowId?: string`
- `SyncWorkflowError.phase`: remove `'enrich'` from union
- `SyncPhase`: remove `'enrich'`
- `SyncProgress`: remove `enriched` and `totalToEnrich`, add `enrichWorkflowId?: string`

### 3. `src/temporal/workflows/sync.ts` — start child enrich workflow

- Add import for `enrichWorkflow` from `./enrich.js`
- Remove `enrichRecord: enrichRecordActivity` from activity proxy (line 36)
- Add `getStubCount` to activity proxy (already exported from `query.ts:75`)
- Remove `enriched` and `totalToEnrich` state variables
- Remove `enrichRecord` from `ops` object (lines 226-231)
- Remove `onEnriched` from `callbacks` (lines 295-301)
- Update `onPhaseStart` callback: remove `totalToEnrich` calculation, keep `totalToDelete`
- Update progress query: remove `enriched` and `totalToEnrich`
- After `engine.run()` returns, add:

```typescript
let enrichWorkflowId: string | undefined;

// After engine.run() result gathering:
if (result.stubTweetsForEnrichment > 0 && !isCancelled) {
  try {
    const stubCount = await getStubCount();
    if (stubCount > 0) {
      enrichWorkflowId = `enrich-after-sync-${wf.workflowInfo().workflowId}`;
      await wf.startChild(enrichWorkflow, {
        workflowId: enrichWorkflowId,
        args: [{ batchSize: 100 } satisfies EnrichWorkflowInput],
        parentClosePolicy: wf.ParentClosePolicy.ABANDON,
      });
    }
  } catch {
    // Best-effort: duplicate workflow ID or other start failure
  }
}
```

- Return `enriched: 0`, add `enrichWorkflowId` to result

### 4. `src/commands/sync-adapter.ts` — remove enrichRecord method

- Delete `enrichRecord` method (lines 163-218)
- Remove unused imports: `EnrichRecordResult`, `FIELDS_VERSION`, `logger`, `selectEnrichmentSource`, `FetchTweetResult`

### 5. `src/commands/sync.ts` — update CLI output

- Remove `onEnriched` callback (lines 244-250)
- Update `onStored` stub message: `"N stub records need enrichment (run separately)"`
- Remove enrichment count display from summary (lines 315-319)
- Add stub notification after summary:

  ```text
  N stub records stored — run enrichment separately:
    pnpm dev workflow start enrich
    pnpm dev sync enrich --outdated
  ```

- Update phase header: `'process'` → "Deleting bookmarks" (was "Processing bookmarks")

### 6. `src/commands/workflow.ts` — update status display

- Remove sync enrichment progress lines (333-337)
- Add `enrichWorkflowId` display when present in sync progress

## Test changes

### Delete: `tests/sync-engine-enrich.test.ts`

All 7 tests test enrichment within the sync engine process phase — no longer relevant.

### Delete: `tests/sync-adapter.test.ts`

All 3 tests test `CliSyncOperations.enrichRecord` — method no longer exists.

### Update: `tests/sync-engine-retry.test.ts`

Remove `enrichRecord` from `createOps` mock helper.

### Update: `tests/sync-engine-resume.test.ts`

Remove `enrichRecord` from `createOps` mock helper.

### Add: new tests for decoupled behavior

- **"process phase deletes without enriching"** — stub tweets go to delete/enqueue, no enrichRecord call
- **"stubTweetsForEnrichment populated from store phase"** — verify result field

### No changes needed

- `tests/temporal-enrich-workflow.test.ts` — EnrichWorkflow is unchanged
- `tests/temporal-activities.test.ts` — enrichRecord activity is unchanged
- `tests/temporal-fetch-activities.test.ts` — fetch activities unchanged

## Verification

1. `pnpm typecheck` — confirms interface changes are consistent
2. `pnpm test` — all updated/new tests pass
3. `pnpm lint` — passes
4. Manual: `pnpm dev sync --local --dry-run <folder-id>` — no enrichment phase in output
5. Inspect Temporal workflow code: `startChild` uses `ParentClosePolicy.ABANDON`
