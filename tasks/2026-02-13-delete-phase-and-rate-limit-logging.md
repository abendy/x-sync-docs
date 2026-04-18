# Improve delete-phase and rate-limit logging

## Context

During a 3-page folder sync, the delete phase appeared to stall after 42 deletes with no
output for ~12 minutes. The system was actually working correctly — doing a durable Temporal
sleep until the X API DELETE rate limit (50 req/15 min) reset. But there was no visibility
into what was happening. The rate limit handling uses a hybrid approach (reactive 429 + proactive
header-based), but almost all rate limit state is logged at DEBUG level or not at all.

**Goal:** Make rate limit pauses, delete progress, and phase summaries clearly visible in both
the CLI output and the daily log file, so operators immediately understand what's happening.

---

## Changes

### 1. Add new callbacks to `SyncCallbacks` (`src/lib/sync-engine.ts`)

Add three new optional callbacks to the existing interface:

```typescript
onDeleteBatchStart?(total: number): void;
onRateLimitPause?(resetAt: number): void;
onRateLimitResume?(): void;
```

- `onDeleteBatchStart` — fired at the start of delete iteration (both backlog and process phases) with the total count
- `onRateLimitPause` — fired in `deleteWithRetry()` when catching a `RateLimitError`, before calling `handleRateLimitError()`
- `onRateLimitResume` — fired in `deleteWithRetry()` after `handleRateLimitError()` returns

Also fire `onRateLimitPause`/`onRateLimitResume` in `fetchWithRetry()` for fetch-phase rate limits.

### 2. Fire new callbacks from `SyncEngine` (`src/lib/sync-engine.ts`)

**`runBacklogPhase()`:**

- Fire `onDeleteBatchStart(pendingDeletes.length)` before the loop

**`runProcessPhase()`:**

- Fire `onDeleteBatchStart(this.allTweets.length)` before the loop

**`deleteWithRetry()`:**

```typescript
private async deleteWithRetry(tweetId: string): Promise<boolean> {
  await this.ops.waitForRateLimit();
  while (true) {
    try {
      return await this.ops.deleteBookmark(tweetId);
    } catch (error) {
      if (this.isRateLimitError(error)) {
        const resetAt = (error as { resetAt: number }).resetAt;
        this.callbacks.onRateLimitPause?.(resetAt);
        await this.ops.handleRateLimitError(resetAt);
        this.callbacks.onRateLimitResume?.();
        continue;
      }
      throw error;
    }
  }
}
```

**`fetchWithRetry()`:** — same pattern, add `onRateLimitPause`/`onRateLimitResume` around the `handleRateLimitError` call.

### 3. CLI callbacks (`src/commands/sync.ts`)

Add closure variables and implement the new callbacks:

```typescript
let deleteBatchTotal = 0;
let deleteBatchCount = 0;

const callbacks: SyncCallbacks = {
  // ... existing callbacks ...

  onDeleteBatchStart: (total: number) => {
    deleteBatchTotal = total;
    deleteBatchCount = 0;
  },

  onDeleted: (tweetId: string, success: boolean) => {
    deleteBatchCount++;
    if (success) {
      console.log(kleur.green(`  Deleted ${tweetId} (${deleteBatchCount}/${deleteBatchTotal})`));
    } else {
      console.log(kleur.red(`  Failed to delete ${tweetId} (${deleteBatchCount}/${deleteBatchTotal})`));
    }
  },

  onRateLimitPause: (resetAt: number) => {
    console.log(
      kleur.yellow(
        `  Rate limit reached (${deleteBatchCount}/${deleteBatchTotal} deleted). ` +
        `Waiting until ${new Date(resetAt).toLocaleTimeString()}...`
      )
    );
  },

  onRateLimitResume: () => {
    console.log(kleur.green('  Rate limit reset. Resuming...'));
  },
};
```

### 4. Temporal workflow callbacks (`src/temporal/workflows/sync.ts`)

Implement in the workflow's `callbacks` object:

```typescript
onDeleteBatchStart: (total: number) => {
  totalToDelete = total;
},

onRateLimitPause: (resetAt: number) => {
  nextRateLimitReset = workflowIsoFromMs(resetAt);
},

onRateLimitResume: () => {
  nextRateLimitReset = undefined;
},
```

Note: `totalToDelete` is already set in `onPhaseStart` for the process phase. Moving it to
`onDeleteBatchStart` is cleaner and also covers the backlog phase. Remove the `totalToDelete`
assignment from `onPhaseStart`.

### 5. Activity-level rate limit logging (`src/temporal/activities/delete.ts`)

After getting the rate limit snapshot, log when the limit is exhausted so it appears in the
worker terminal and daily log file:

```typescript
const snapshot = getRateLimitSnapshot(rateLimiter);
if (snapshot?.remaining === 0 && snapshot.resetAt) {
  logger.info('RATE', `Delete rate limit exhausted, resets at ${new Date(snapshot.resetAt).toLocaleTimeString()}`);
}
```

This is the key change for the worker log / daily log visibility.

### 6. Promote proactive wait log level (`src/lib/rate-limiter.ts`)

The `waitForNextSlot()` method already logs at INFO when `headerRemaining === 0`. No change
needed there. But `updateFromHeaders()` logs at DEBUG only — promote the `remaining` log to
INFO when it reaches 0:

```typescript
if (headers['x-rate-limit-remaining'] !== undefined) {
  this.headerRemaining = Number.parseInt(headers['x-rate-limit-remaining'], 10);
  if (this.headerRemaining === 0) {
    logger.info('RATE', `Rate limit remaining: 0 (resets at ${new Date(this.headerResetAt!).toLocaleTimeString()})`);
  } else {
    logger.debug('RATE', `Remaining requests: ${this.headerRemaining}`);
  }
}
```

---

## Files to modify

| File | Change |
| --- | --- |
| `src/lib/sync-engine.ts` | Add 3 new callbacks, fire them in `deleteWithRetry`, `fetchWithRetry`, `runBacklogPhase`, `runProcessPhase` |
| `src/commands/sync.ts` | Implement new callbacks with progress counters and rate limit messages |
| `src/temporal/workflows/sync.ts` | Implement new callbacks for workflow progress state, remove redundant `totalToDelete` from `onPhaseStart` |
| `src/temporal/activities/delete.ts` | Log rate limit exhaustion after delete |
| `src/lib/rate-limiter.ts` | Promote `remaining: 0` log to INFO |

---

## What this looks like

**CLI output during delete phase:**

```text
Phase 3: Deleting bookmarks...
  Deleted 1893484758301928 (1/20)
  Deleted 1893484758301929 (2/20)
  ...
  Deleted 1893484758301946 (18/20)
  Rate limit reached (18/20 deleted). Waiting until 9:38:53 PM...
  Rate limit reset. Resuming...
  Deleted 1893484758301947 (19/20)
  Deleted 1893484758301948 (20/20)
```

**Worker log (daily log file):**

```json
{"ts":"...","level":"info","message":"[DELETE] Deleted bookmark 1893484758301946 from X"}
{"ts":"...","level":"info","message":"[RATE] Delete rate limit exhausted, resets at 9:38:53 PM"}
{"ts":"...","level":"info","message":"[DELETE] Deleted bookmark 1893484758301947 from X"}
```

**Workflow status command (unchanged, already works):**

```text
  Deleted: 42 / 20
  Rate Limit Reset: 9:38:53 PM
```

---

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm lint` — no lint errors
3. `pnpm test` — all tests pass (callbacks are optional, so existing tests unaffected)
4. Manual test: `pnpm dev sync <folder-id> --local --pages 3` — verify CLI output shows progress and rate limit messages
5. Manual test: `pnpm dev sync <folder-id> --pages 3` (Temporal) — verify worker logs show rate limit events and `workflow status` shows progress

---

## Code Review Action Items (2026-02-14)

1. [x] **P1: Make rate-limit callbacks phase-aware to avoid misleading CLI output**
Observed in `src/lib/sync-engine.ts` (`fetchWithRetry`) and `src/commands/sync.ts` (`onRateLimitPause`): fetch-phase rate limits currently print delete-specific text (`X/Y deleted`), which is incorrect and can show stale counters (`0/0` or prior batch values).
Action: update callback payload to include operation context (for example: `'fetch' | 'delete'`) and render phase-specific messaging in CLI/Temporal.
Done when: a fetch 429 shows a fetch-specific wait message, and delete progress text appears only during delete/backlog operations.
Resolution: Added `context: 'fetch' | 'delete'` parameter to `onRateLimitPause`. `fetchWithRetry` passes `'fetch'`, `deleteWithRetry` passes `'delete'`. CLI renders delete-specific progress counters only for `'delete'` context; fetch shows generic message.

2. [x] **P1: Fix stale workflow progress state during backlog phase**
Observed in `src/temporal/workflows/sync.ts` (`onPhaseStart`): backlog was excluded from the reset branch, so `currentItem`/`totalToDelete` can remain stale when backlog is empty (especially across multi-page runs).
Action: reset batch-specific progress state at backlog phase start, then set real totals only when `onDeleteBatchStart` fires.
Done when: workflow progress during an empty backlog reports `totalToDelete = 0` and no stale `currentItem`.
Resolution: Simplified `onPhaseStart` to unconditionally reset `currentItem`, `totalToDelete`, and `deletedInBatch` at every phase transition. `onDeleteBatchStart` sets real values when it fires.

3. [x] **P2: Resolve progress-metric mismatch (`deleted` cumulative vs `totalToDelete` batch-local)**
Current workflow status can show logically inconsistent ratios (for example `Deleted: 42 / 20`), which undermines operator trust in status telemetry.
Action: either expose both metrics explicitly (`deletedTotal`, `deletedInBatch`, `batchTotal`) or align numerator/denominator to the same scope.
Done when: status output never presents a numerator larger than denominator for the same metric.
Resolution: Added `deletedInBatch` to `SyncProgress`. Tracked in workflow: reset in `onDeleteBatchStart`/`onPhaseStart`, incremented in `onDeleted`. Workflow status now shows `Deleted: 3/20 (42 total)` — batch-local ratio with cumulative total when they differ.

4. [x] **P2: Add targeted regression tests for new callback/progress behavior**
The new callback paths are not directly covered by tests, so the above edge cases can regress silently.
Action: add tests in `tests/sync-engine-retry.test.ts` for callback payload/order and in `tests/temporal-sync-workflow.test.ts` for backlog-empty progress state and rate-limit reset visibility.
Done when: tests fail without the fixes above and pass after implementing them.
Resolution: Added 4 tests in `sync-engine-retry.test.ts` (batch start totals for process/backlog, rate limit context for delete/fetch) and 2 tests in `temporal-sync-workflow.test.ts` (deletedInBatch reset between pages, clean progress after empty backlog). Total: 150 tests passing.

5. [x] **P3: Standardize operator-facing reset timestamps in logs**
Current messages use `toLocaleTimeString()` in multiple files (`src/commands/sync.ts`, `src/lib/rate-limiter.ts`, `src/temporal/activities/delete.ts`), which is ambiguous across locales/time zones and harder to correlate with ISO log timestamps.
Action: log reset time in a normalized format (ISO 8601 or local time + explicit offset) consistently across CLI and worker logs.
Done when: the same reset event can be correlated between CLI output and log files without locale assumptions.
Resolution: Added `formatResetTime()` helper to `rate-limiter.ts` producing `HH:MM:SS ±HHMM` format. Replaced `toLocaleTimeString()` in `rate-limiter.ts`, `delete.ts`, and `sync.ts` rate limit callbacks. Reordered `updateFromHeaders()` to parse reset header before remaining to avoid null reference.

---

## Follow-up Code Review Action Items (2026-02-14)

1. [x] **P1: Fix `deletedInBatch` semantics (currently counts failures as deletes)**
Observed in `src/temporal/workflows/sync.ts` (`onDeleted`): `deletedInBatch` increments for both success and failure, but `workflow status` labels this metric as "Deleted", which can over-report successful deletes.
Action: either increment `deletedInBatch` only on success, or rename/replace it with `processedInBatch` and update UI labels accordingly.
Done when: status text cannot imply failed deletes were successful.
Resolution: Renamed `deletedInBatch` to `processedInBatch` in `SyncProgress`, workflow state, and tests. Updated `workflow status` display to label it `processed` — e.g. `Deleted: 18/20 processed (42 deleted)`.

2. [x] **P2: Tighten regression test for batch-reset behavior**
Observed in `tests/temporal-sync-workflow.test.ts` (`progress query shows deletedInBatch reset between pages`): the test comment describes `deletedInBatch` expectations but no assertion enforces it.
Action: add an explicit assertion for `progress.deletedInBatch` in this test.
Done when: the test fails if `deletedInBatch` no longer resets as intended.
Resolution: Added `expect(progress.processedInBatch).toBe(0)` assertion to the multi-page test.

3. [x] **P3: Avoid confusing `0/0` delete output outside delete phases**
Observed in `src/commands/workflow.ts`: status always prints `Deleted: deletedInBatch/totalToDelete`, yielding `0/0` during fetch/store phases.
Action: conditionally render ratio only when `totalToDelete > 0`; otherwise show cumulative deleted total.
Done when: non-delete phases no longer display `0/0`.
Resolution: Workflow status now conditionally renders: shows `Deleted: N/M processed (X deleted)` when `totalToDelete > 0`, otherwise plain `Deleted: X`.
