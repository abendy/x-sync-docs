# Fix: Enrichment runs sequentially instead of concurrently with deletes

## Context

The `onBeforeProcess` callback in SyncEngine (added in 6f76830) was designed to start a child EnrichWorkflow between the store and delete phases so enrichment runs concurrently with deletes. However, the callback never fires activities in the actual Temporal sandbox — the workflow history shows zero `getStubCount` calls between `storeBookmarks` and `deleteBookmarkFromX`. Enrichment only starts via the post-loop reconciliation, making it fully sequential.

The unit tests pass because they mock `@temporalio/workflow` directly, bypassing the sandbox. The fix is to stop relying on a callback invoked deep inside SyncEngine and instead give the workflow explicit phase control.

## Approach

Expose phased execution on SyncEngine so the Temporal workflow calls phases directly rather than delegating to a monolithic `run()` + callback.

### 1. `src/lib/sync-engine.ts` — Add phased execution methods

Add two public methods:

```typescript
async runThroughStore(): Promise<SyncResult>   // backlog + fetch + store
async runProcess(): Promise<SyncResult>        // delete/enqueue phase only
```

Refactor `run()` to delegate to these (preserves backward compat for CLI path):

```typescript
async run(): Promise<SyncResult> {
  await this.runThroughStore();
  if (this.checkCancelled()) return this.result;
  if (this.allTweets.length > 0) {
    if (this.callbacks.onBeforeProcess) {
      await this.callbacks.onBeforeProcess();
    }
    await this.runProcess();
  }
  this.result.phase = 'complete';
  return this.result;
}
```

Also expose a `hasTweets()` getter so the workflow can check whether process phase is needed.

### 2. `src/temporal/workflows/sync.ts` — Use phased execution

Replace `engine.run()` with explicit phase calls:

```typescript
for (let page = 1; page <= totalPages; page++) {
  engine = new SyncEngine(ops, { ... }, callbacks);  // callbacks WITHOUT onBeforeProcess

  await engine.runThroughStore();
  if (isCancelled) break;

  // Start enrichment directly — first-class workflow code, not a callback
  if (!enrichStarted && !isCancelled && engine.hasTweets()) {
    try {
      const stubCount = await getStubCount();
      if (stubCount > 0) {
        const id = `enrich-after-sync-${wf.workflowInfo().workflowId}`;
        await wf.startChild(enrichWorkflow, { workflowId: id, ... });
        enrichWorkflowId = id;
        enrichStarted = true;
      }
    } catch (error) { /* record error */ }
  }

  if (engine.hasTweets()) {
    await engine.runProcess();
  }

  const result = engine.getResult();
  // ... aggregate counters, check early exit
}
```

Remove `onBeforeProcess` from the callbacks object. Keep the reconciliation block as a safety net.

### 3. Tests

- **`tests/sync-engine-decouple.test.ts`** — Add tests for `runThroughStore()` + `runProcess()` phased execution
- **`tests/temporal-sync-workflow.test.ts`** — Update "starts enrichment before delete phase" test. The call ordering verification remains the same but the mechanism changes (direct calls vs callback). Update duplicate/reconciliation tests to match new structure.

## Files to modify

| File | Change |
| --- | --- |
| `src/lib/sync-engine.ts` | Add `runThroughStore()`, `runProcess()`, `hasTweets()`. Refactor `run()` to delegate. |
| `src/temporal/workflows/sync.ts` | Replace `engine.run()` with phased calls. Move enrichment start inline. Remove `onBeforeProcess` from callbacks. |
| `tests/sync-engine-decouple.test.ts` | Add phased execution tests |
| `tests/temporal-sync-workflow.test.ts` | Update enrichment ordering tests |

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm test` — all tests pass
3. `pnpm lint` — no lint issues
4. Manual: `pnpm dev sync <folder-id> --pages 3` then check `temporal workflow show -w <id>` — `getStubCount` and `START_CHILD_WORKFLOW_EXECUTION_INITIATED` should appear BEFORE `deleteBookmarkFromX` events

## Code Review Action Items

1. **[High] Preserve per-page aggregation when cancellation happens after `runThroughStore()`**
   - **Where:** `src/temporal/workflows/sync.ts:408`, `src/temporal/workflows/sync.ts:409`, `src/temporal/workflows/sync.ts:445`
   - **Issue:** The loop `break`s immediately when `isCancelled` is true after `runThroughStore()`, before reading and aggregating `engine.getResult()`.
   - **Impact:** `newRecords`, `dataCompleteness`, and mapped `result.errors` for the current page can be dropped from the final workflow result, even though fetch/store work already happened.
   - **Action:** Always capture `const result = engine.getResult()` and aggregate page counters/errors before cancel exit. Then break to skip process/reconciliation as appropriate.
   - **Acceptance test:** Add a workflow test that triggers cancel after store and asserts final result still includes stored/new-record counts from that page.

2. **[Medium] Tighten `SyncEngine` phased execution entry points with explicit state guards**
   - **Where:** `src/lib/sync-engine.ts:263`, `src/lib/sync-engine.ts:288`
   - **Issue:** Public phased methods allow ambiguous call orders (`runProcess()` before `runThroughStore()`) and unclear behavior with `dryRun` when phased methods are called directly.
   - **Impact:** Future callers can accidentally run unsupported execution paths without immediate feedback, which makes refactors riskier and debugging harder.
   - **Action:** Add an internal phase-state guard (for example: `idle -> throughStore -> processed`) and enforce legal transitions. Define/implement `dryRun` behavior for phased APIs explicitly (either guarded error or fully supported path).
   - **Acceptance test:** Add unit tests that assert invalid call orders fail fast with deterministic error messages.

3. **[Medium] Add coverage for cancellation timing in the new phased workflow path**
   - **Where:** `tests/temporal-sync-workflow.test.ts` (new tests)
   - **Issue:** Current tests verify enrichment ordering and reconciliation, but do not cover cancel boundaries introduced by splitting `run()` into `runThroughStore()` + `runProcess()`.
   - **Impact:** Regressions around cancel behavior (counter accuracy, skipped process phase, error propagation) can slip through.
   - **Action:** Add targeted tests for:
     - cancel before process starts (after store completes),
     - cancel during fetch/backlog loops,
     - assertion that delete/process activities are not called after cancellation.

4. **[Low] Clarify long-term contract of `onBeforeProcess` now that workflow path is explicit**
   - **Where:** `src/lib/sync-engine.ts:87`, `src/lib/sync-engine.ts:246`
   - **Issue:** The callback still exists, but orchestration now relies on explicit phased execution in workflow code.
   - **Impact:** Two orchestration patterns remain in public API; this can cause confusion for future contributors about the preferred extension point.
   - **Action:** Document `onBeforeProcess` as legacy/CLI compatibility only (or deprecate/remove it in a follow-up), and point new integrations to phased execution methods.
