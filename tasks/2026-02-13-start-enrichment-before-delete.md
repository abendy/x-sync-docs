# Start Enrichment Before Delete Phase

## Context

The sync workflow runs phases sequentially: backlog → fetch → store → **delete**. The delete phase can block for extended periods when the X API rate limit is exhausted (15-minute durable sleep windows). Currently, the child EnrichWorkflow is only started **after** the entire multi-page sync loop completes (`sync.ts:420-443`), meaning enrichment waits for all deletes to finish — which can be hours on large runs.

Since EnrichWorkflow is already fully independent (ABANDON policy, queries DB directly, loops until all stubs processed), there's no reason it needs to wait for deletes. The fix: start enrichment **between the store and delete phases**.

## Changes

### 1. `src/lib/sync-engine.ts` — Add async `onBeforeProcess` callback

Add to `SyncCallbacks` interface:

```typescript
onBeforeProcess?(): Promise<void>;
```

Call it in `run()` after store, before process — gated on `allTweets.length > 0`:

```typescript
if (this.allTweets.length > 0) {
  if (this.callbacks.onBeforeProcess) {
    await this.callbacks.onBeforeProcess();
  }
  await this.runProcessPhase();
}
```

### 2. `src/temporal/workflows/sync.ts` — Move enrichment start into callback

- Add `let enrichStarted = false` guard flag in workflow state
- Move the `startChild(enrichWorkflow)` logic into an `onBeforeProcess` callback on the `callbacks` object
- Guard prevents duplicate starts across multi-page runs
- On failure, set `enrichStarted = true` to avoid retry on subsequent pages
- Remove the post-loop enrichment block (lines 420-443)
- Remove dead `totalStubsForEnrichment` variable and accumulator

### 3. `tests/temporal-sync-workflow.test.ts` — Add timing tests

- **"starts enrichment before delete phase"** — verify `startChild` is called before `deleteBookmarkFromX` using call-order tracking
- **"starts enrichment only once across multiple pages"** — verify `startChild` called exactly once with 3+ pages
- **"skips enrichment when getStubCount returns zero"** — verify `startChild` not called
- Existing "records process error when child enrich workflow start fails" test should pass unchanged

### Files NOT changed

- `src/commands/sync.ts` — CLI doesn't implement `onBeforeProcess`, still shows manual notification
- `src/temporal/workflows/enrich.ts` — completely unchanged
- Activities — unchanged
- `tests/sync-engine-decouple.test.ts` — engine tests don't provide `onBeforeProcess`, work as-is

## Verification

1. `pnpm typecheck` — ensure no type errors from new async callback
2. `pnpm test` — all existing tests pass, new tests pass
3. `pnpm lint` — no lint issues
4. Manual: run `pnpm dev sync <folder-id> --pages 2` with Temporal dev server, verify `workflow status` shows `enrichWorkflowId` populated before delete phase completes

## Code Review Action Items

1. **[High] Guarantee enrichment coverage for stubs created on later pages**
   - **Issue:** `onBeforeProcess` sets `enrichStarted = true` after the first page attempt (`src/temporal/workflows/sync.ts:379-411`), and the old post-loop start block was removed. In multi-page runs, the early child workflow can finish before later pages are fetched/stored; those later stubs may never be enriched in this sync execution.
   - **Why this matters:** This is a correctness regression versus the previous post-loop behavior, which always started enrichment after all pages were processed.
   - **Action:** Keep early-start behavior, but add a post-loop reconciliation step: if `getStubCount() > 0` at the end of paging and no enrich run is active/guaranteed to pick them up, start enrichment again (or equivalent durable handoff).
   - **Acceptance criteria:** For `pages > 1`, stubs introduced on the last page are still enriched automatically without requiring a manual `sync enrich`.

2. **[High] Do not permanently suppress later enrichment attempts when first page has zero stubs**
   - **Issue:** `enrichStarted` is set to `true` even when `stubCount === 0` (`src/temporal/workflows/sync.ts:384-395`). If page 1 has no stubs but a later page does, enrichment is never started.
   - **Action:** Only lock out future attempts after a workflow is actually started (or after an explicit final reconciliation pass), not after a zero-stub check.
   - **Acceptance criteria:** A run where `getStubCount()` returns `0` on page 1 and `>0` on page 2 still launches enrichment.

3. **[Medium] Add regression tests for cross-page timing/coverage gaps**
   - **Issue:** New tests validate call ordering and single-start behavior, but they do not cover the two failure modes above (`tests/temporal-sync-workflow.test.ts:268-357`).
   - **Action:** Add tests for:
     - page 1 zero stubs, later page non-zero stubs;
     - enrichment started early, later pages add stubs, and a final reconciliation still starts/ensures enrichment coverage.
   - **Acceptance criteria:** Tests fail on current logic and pass with the fixes.

4. **[Low] Align workflow comments with actual lifecycle**
   - **Issue:** The sync workflow header still says enrichment starts "after sync completes" (`src/temporal/workflows/sync.ts:72-80`), which is now inaccurate and makes reasoning harder for future refactors.
   - **Action:** Update comments/docs to reflect "start before delete with end-of-run reconciliation" (or whatever final behavior is implemented).
   - **Acceptance criteria:** No stale comments describing the old post-loop-only start behavior.

## Follow-up Review Action Items (2026-02-14)

1. [x] **[Medium] Prevent duplicate concurrent enrichment workflows during reconciliation** (Completed 2026-02-14)
   - **Issue:** Reconciliation always starts a second child when `remainingStubs > 0` (`src/temporal/workflows/sync.ts:455-463`), even if the early child is still actively processing those stubs. Because `enrichWorkflow` has no cross-workflow dedupe, two runs can fetch/enrich the same tweet concurrently (`src/temporal/workflows/enrich.ts:173-229`, `src/temporal/activities/store.ts:125-147`).
   - **Impact:** Redundant enrichment API calls increase rate-limit pressure and cost, and can reduce throughput under heavy sync loads.
   - **Action:** Add idempotent coordination for early + reconciliation starts (for example: reuse one deterministic child workflow ID and treat "already running" as success, or add an explicit "enrich already running" check before reconciliation start).
   - **Acceptance criteria:** When early enrichment is still running at end-of-loop, reconciliation does not create a second concurrent worker for the same stub set.
   - **Implemented:** Reconciliation now reuses the early child workflow ID and suppresses only true duplicate-start errors; non-duplicate reconciliation failures are surfaced as process errors.
   - **Validation:** Added tests for duplicate suppression and non-duplicate reconciliation failure reporting in `tests/temporal-sync-workflow.test.ts`.

## Final Pass Action Items (2026-02-14)

1. [x] **[Low] Tighten duplicate-start detection to reduce false-positive suppression** (Completed 2026-02-14)
   - **Issue:** Duplicate detection currently falls back to message regex matching (`src/temporal/workflows/sync.ts`, `WORKFLOW_ALREADY_STARTED_REGEX`). A non-duplicate error containing similar text could be incorrectly suppressed.
   - **Action:** Prefer structured detection first (`error.name === 'WorkflowExecutionAlreadyStartedError'`) and narrow/fence the regex fallback (exact-match wording or explicit allowlist of known Temporal messages).
   - **Acceptance criteria:** Reconciliation suppression only occurs for true duplicate child-start conflicts; unrelated failures are always reported.
   - **Implemented:** `isDuplicateChildStartError` now checks structured error name first and regex fallback is narrowed to exact canonical message matching.
   - **Validation:** Confirmed by targeted tests in `tests/temporal-sync-workflow.test.ts` and full lint/typecheck.

2. [x] **[Low] Add a test that exercises name-based duplicate detection** (Completed 2026-02-14)
   - **Issue:** Current duplicate suppression test asserts message-based detection only (`tests/temporal-sync-workflow.test.ts`), but runtime behavior is expected to come from Temporal’s error class/name.
   - **Action:** Add a focused test where reconciliation throws an error object with `name: 'WorkflowExecutionAlreadyStartedError'` (with non-matching message) and verify suppression still works.
   - **Acceptance criteria:** Test proves duplicate suppression works via error name, independent of message text.
   - **Implemented:** Added `suppresses reconciliation duplicate error via error name`.
   - **Validation:** `pnpm test tests/temporal-sync-workflow.test.ts` now passes with this case included.
