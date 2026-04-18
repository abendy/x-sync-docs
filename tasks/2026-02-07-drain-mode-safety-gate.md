# Plan: Drain Mode & Enrich-Before-Delete Safety Gate

## Context

The X API folder endpoint returns at most 20 bookmark IDs per request with no pagination token. The only way to access older bookmarks is to delete the visible ones, revealing the next batch. The current `SyncEngine` runs a single pass (fetch→store→enrich→delete), which processes only one batch of 20 and stops.

To fully drain a folder, the engine needs to cycle: fetch 20 → store → enrich → delete 20 → fetch next 20 → ... until the folder is empty or no progress is made. Additionally, the current delete phase deletes ALL fetched tweets regardless of enrichment status — a stub that failed enrichment gets deleted and the data is lost forever.

This plan adds:

1. **Drain mode** (`--drain` flag) — cycles fetch→store→enrich→delete until empty/stalled
2. **Enrich-before-delete safety gate** (always on) — skip deleting unenriched stubs, enqueue them instead

## Changes

### 1. `src/lib/sync-engine.ts` — Core engine changes

**Add `drain` to `SyncOptions`** (line 72):

```typescript
drain?: boolean;
```

**Add cycle tracking to `SyncResult`** (line 98):

```typescript
cycles: number;
drainStopped?: string; // reason drain stopped: 'empty' | 'no-progress' | 'limit' | 'cancelled'
```

**Add cycle callbacks to `SyncCallbacks`** (line 84):

```typescript
onCycleStart?(cycle: number): void;
onCycleComplete?(cycle: number, deletedThisCycle: number): void;
```

**Add instance fields** to track enrichment failures and cycle state:

```typescript
private enrichFailedIds: Set<string> = new Set();
private cycleCount = 0;
```

**Refactor `run()`** (line 240): Extract single-cycle logic into `runSingleCycle()`, add drain loop:

- `run()` becomes: if `drain`, call `runDrainLoop()`, else call `runSingleCycle()`
- `runSingleCycle()` contains the current backlog→fetch→store→enrich→delete flow
- `runDrainLoop()` calls `runSingleCycle()` in a loop with `resetCycleState()` between cycles

**Add `resetCycleState()`**: Clear per-cycle collections (`allTweets`, `allUsers`, `allMedia`, `allIncludedTweets`, `enrichFailedIds`) between drain cycles. Do NOT reset `result` accumulators — they accumulate across cycles.

**Fix `runStorePhase()`** (line 436): Change `=` assignments to `+=` so results accumulate across drain cycles:

```typescript
this.result.newBookmarks += storeResult.newBookmarks;
this.result.updatedBookmarks += storeResult.updatedBookmarks;
this.result.fullTweets += storeResult.fullTweets;
this.result.stubTweets += storeResult.stubTweets;
```

**Modify `runEnrichPhase()`** (line 444): Track failed tweet IDs in `enrichFailedIds`:

```typescript
// In the catch/failure branch:
this.enrichFailedIds.add(tweet.id);
```

**Modify `runDeletePhase()`** (line 492): Add enrich-before-delete safety gate:

```typescript
for (const tweet of this.allTweets) {
  // Safety gate: skip unenriched stubs
  if (!tweet._fullJson && this.enrichFailedIds.has(tweet.id)) {
    await this.ops.enqueueDelete(tweet.id, this.options.folderId);
    this.callbacks.onWarning?.(`Skipped delete for ${tweet.id}: enrichment failed, queued for retry`);
    continue;
  }
  // ... existing delete logic
}
```

**Add `runDrainLoop()`**:

```typescript
private async runDrainLoop(): Promise<void> {
  while (true) {
    this.cycleCount++;
    this.callbacks.onCycleStart?.(this.cycleCount);

    const deletedBefore = this.result.newDeleted;
    await this.runSingleCycle();

    const deletedThisCycle = this.result.newDeleted - deletedBefore;
    this.callbacks.onCycleComplete?.(this.cycleCount, deletedThisCycle);

    if (this.checkCancelled()) {
      this.result.drainStopped = 'cancelled';
      break;
    }

    // Stop conditions
    if (this.result.totalFetched === 0 || this.allTweets.length === 0) {
      this.result.drainStopped = 'empty';
      break;
    }
    if (deletedThisCycle === 0) {
      this.result.drainStopped = 'no-progress';
      break;
    }
    if (this.options.limit !== undefined && this.result.totalFetched >= this.options.limit) {
      this.result.drainStopped = 'limit';
      break;
    }

    this.resetCycleState();
  }
  this.result.cycles = this.cycleCount;
}
```

Initialize `cycles: 0` in result default and set `cycles: 1` at end of `runSingleCycle()` for non-drain mode.

### 2. `src/commands/sync.ts` — CLI flag

**Add `--drain` option** (after line 54):

```typescript
.option('--drain', 'Cycle fetch/enrich/delete until folder is empty')
```

**Add to `SyncBookmarksOptions`** interface:

```typescript
drain?: boolean;
```

**Validate** (after line 88): `--drain` with `--no-delete` is an error (drain requires deletion to reveal next batch):

```typescript
if (options.drain && noDelete) {
  console.log(kleur.red('Error: --drain requires delete (cannot use with --no-delete)'));
  process.exit(1);
}
```

**Pass `drain` to `SyncEngine`** options (line 277).

**Add cycle callbacks** to the CLI callbacks object:

```typescript
onCycleStart: (cycle: number) => {
  console.log(kleur.cyan(`\n--- Cycle ${cycle} ---`));
},
onCycleComplete: (cycle: number, deletedThisCycle: number) => {
  console.log(kleur.gray(`  Cycle ${cycle} complete: ${deletedThisCycle} deleted`));
},
```

**Update summary** to show cycles and drain stop reason.

### 3. `src/temporal/shared/types.ts` — Temporal types

**Add to `SyncWorkflowInput`** (line 20):

```typescript
drain?: boolean;
```

**Add to `SyncWorkflowResult`** (line 30):

```typescript
cycles: number;
drainStopped?: string;
```

**Add to `SyncProgress`** (line 50):

```typescript
cycle: number;
```

### 4. `src/temporal/workflows/sync.ts` — Temporal workflow

**Add `cycle` tracking** to workflow state (line 79):

```typescript
let cycle = 0;
```

**Pass `drain`** to `SyncEngine` options (line 331).

**Update progress query** to include `cycle`.

**Update result mapping** to include `cycles` and `drainStopped`.

### 5. Tests

**New file: `tests/sync-engine-drain.test.ts`**

Test cases:

1. **Single cycle when fetch returns empty** — drain stops with `drainStopped: 'empty'`
2. **Multiple cycles until empty** — mock fetch returns tweets on cycle 1 and 2, empty on cycle 3
3. **No-progress detection** — all deletes fail, drain stops with `drainStopped: 'no-progress'`
4. **Enrich-before-delete safety gate** — stub with failed enrichment is enqueued, not deleted
5. **Results accumulate across cycles** — totalFetched, newBookmarks, newDeleted sum across cycles
6. **Limit stops drain** — `drainStopped: 'limit'` when totalFetched reaches limit
7. **Cancellation during drain** — `drainStopped: 'cancelled'`
8. **`--drain --no-delete` rejected** — validation test (CLI level, or engine-level error)

**Update existing tests**: Add `cycles: 0` (or `cycles: 1`) to result assertions where `SyncResult` is checked, add `drainStopped` as undefined for non-drain runs.

## Files Modified

| File | Change |
| --- | --- |
| `src/lib/sync-engine.ts` | Add drain loop, enrich-before-delete gate, cycle tracking, refactor run() |
| `src/commands/sync.ts` | Add `--drain` flag, validation, cycle callbacks |
| `src/temporal/shared/types.ts` | Add `drain`, `cycles`, `drainStopped`, `cycle` to types |
| `src/temporal/workflows/sync.ts` | Pass drain through, track cycles, update result |
| `tests/sync-engine-drain.test.ts` | New test file with 8 drain-specific tests |
| `tests/sync-engine-retry.test.ts` | Add `cycles` to result checks |
| `tests/sync-engine-enrich.test.ts` | Add `cycles` to result checks |

## Verification

1. `pnpm typecheck` — clean
2. `pnpm lint` — clean
3. `pnpm test` — all tests pass including new drain tests
4. Manual: `pnpm dev sync bookmarks <folder-id> --drain --local` cycles until folder is empty
5. Manual: `pnpm dev sync bookmarks <folder-id> --drain --no-delete` errors with validation message
