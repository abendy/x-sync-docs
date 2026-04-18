# Task: Rate limit bypass during Temporal delete phase

**Status:** Complete
**Created:** 2026-02-19
**Completed:** 2026-02-20
**Source:** ~/.claude/plans/memoized-shimmying-puddle.md

## Plan

### Context

When the Temporal sync workflow hits a 429 rate limit during the delete phase, it continues trying to delete remaining bookmarks instead of sleeping until reset. The root cause is that Temporal SDK wraps activity errors in `ActivityFailure` → `ApplicationFailure`, which strips the original `name` and `resetAt` properties. The sync engine's `isRateLimitError()` check (which looks for `error.name === 'RateLimitError'`) fails to detect the wrapped error, causing `withRateLimitRetry()` to re-throw it as a generic error. The process phase's catch block then records it as a regular delete failure and **continues the loop** to the next bookmark.

**Data safety**: All deleted bookmarks were properly stored — the store phase completes before deletes, and the activity verifies bookmark existence before deleting. The bug causes unnecessary API calls, not data loss.

**Same latent bug exists in**: fetch activities and enrich activities (both throw `RateLimitError` through the Temporal activity boundary). The enrich workflow in `pass.ts:77` has the same `isRateLimitError` check on Temporal-wrapped errors.

### Approach: Unwrap Temporal-wrapped errors at the workflow boundary

Fix error detection/unwrapping at two sites rather than redesigning activity return contracts. Activities continue to throw `RateLimitError` as they do today.

**Sync workflow path** (`runtime.ts`): The workflow adapter catches `ActivityFailure`, detects `ApplicationFailure.type === 'RateLimitError'`, and re-throws a plain `{ name: 'RateLimitError', resetAt }` that the existing `isRateLimitError()` in `retry.ts` already detects. Uses `workflowNowMs()` (not `Date.now()`) for determinism.

**Enrich workflow path** (`enrich/rate-limit.ts`): Fix `isRateLimitError()` to also detect `ActivityFailure` → `ApplicationFailure` with `type === 'RateLimitError'`. The existing `handleRateLimitError` already falls back to 15s when `retryAfterMs` is missing.

### Changes

#### [x] 1. Add `rethrowIfRateLimit` helper — `src/temporal/workflows/sync/rate-limit.ts`

Add a helper that unwraps Temporal error wrapping and re-throws with the shape the sync engine expects:

```typescript
export function rethrowIfRateLimit(error: unknown): void {
  // Only handle Temporal-wrapped activity errors
  if (!(error instanceof wf.ActivityFailure)) return;
  const cause = error.cause;
  if (!(cause instanceof wf.ApplicationFailure)) return;
  if (cause.type !== 'RateLimitError') return;

  // Parse retry-after seconds from message ("Rate limited. Retry after 42s")
  const retryAfterMs = parseRetryAfterMs(cause.message) ?? DEFAULT_RATE_LIMIT_WAIT_MS;

  throw Object.assign(new Error(cause.message), {
    name: 'RateLimitError',
    resetAt: workflowNowMs() + retryAfterMs,
    retryAfterMs,
  });
}
```

Uses `workflowNowMs()` for determinism. Parses `retryAfterMs` from the error message with a 15s fallback.

#### [x] 2. Fix workflow delete adapter — `src/temporal/workflows/sync/runtime.ts`

Wrap `deleteBookmark()` (lines 99-104) in try-catch and apply `rethrowIfRateLimit`:

```typescript
async deleteBookmark(tweetId) {
  state.currentItem = tweetId;
  try {
    const result = await activities.deleteBookmarkFromX({ tweetId });
    await waitForRateLimitSnapshot(result.rateLimit);
    return result.success;
  } catch (error) {
    rethrowIfRateLimit(error);
    throw error;
  }
},
```

The re-thrown error has `name: 'RateLimitError'` and `resetAt` — both properties that `isRateLimitError()` in `retry.ts` checks for. This feeds into `withRateLimitRetry` → `handleRateLimitError(resetAt)` → `sleepForRateLimit(resetAt)` → Temporal durable sleep.

#### [x] 3. Fix workflow fetch adapter — `src/temporal/workflows/sync/runtime.ts`

Same pattern for `fetchBookmarks()` (lines 38-80) — wrap in try-catch with `rethrowIfRateLimit`. — *Identical try-catch pattern to delete adapter; `rethrowIfRateLimit` is a no-op for non-rate-limit errors so the original throw propagates unchanged.*

#### [x] 4. Fix enrich `isRateLimitError` — `src/temporal/workflows/enrich/rate-limit.ts`

Update `isRateLimitError` (line 8) to also detect Temporal-wrapped errors:

```typescript
export function isRateLimitError(error: unknown): error is { name: 'RateLimitError'; retryAfterMs?: number } {
  if (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name: string }).name === 'RateLimitError'
  ) {
    return true;
  }

  // Unwrap Temporal ActivityFailure → ApplicationFailure
  if (
    error instanceof wf.ActivityFailure &&
    error.cause instanceof wf.ApplicationFailure &&
    error.cause.type === 'RateLimitError'
  ) {
    return true;
  }

  return false;
}
```

The existing `handleRateLimitError` duck-types `retryAfterMs` with a 15s default (line 18-21), so the wrapped error (which lacks `retryAfterMs`) falls back gracefully. — *Also added `extractRetryAfterMs` helper that checks direct `retryAfterMs` property first, then parses from `ApplicationFailure.message` via shared `parseRetryAfterMs`, then falls back to 15s. This means enrich now gets actual retry-after timing instead of always defaulting to 15s.*

#### [x] 5. Keep `nonRetryableErrorTypes` config

Keep `nonRetryableErrorTypes: ['RateLimitError']` in both `sync/activities.ts` and `enrich/activities.ts` as a belt-and-suspenders safeguard. — *Verified unchanged.*

### No changes to

- Activity return types (`DeleteBookmarkOutput`, `EnrichRecordOutput`, `FetchBookmarksOutput`)
- Activity implementations (`delete.ts`, `fetch.ts`, `store.ts`)
- Sync engine shared code (`retry.ts`, `rate-limit-retry.ts`)
- `withRateLimitRetry` contract

### Additional: Shared `parseRetryAfterMs` — `src/temporal/workflows/parse-retry-after.ts` (new file)

Promoted from backlog per feedback tweaks #1 and #2. Shared parser used by both `sync/rate-limit.ts` and `enrich/rate-limit.ts`:
- Regex: `/Retry after (\d+)s/`
- Returns `undefined` for missing, empty, non-matching, or non-positive input
- Clamps valid results to [1s, 24h] (1,000ms – 86,400,000ms)

### Verification

- [x] **Unit tests**: Existing `sync-engine-retry.test.ts` passes (sync engine interface unchanged) — 10 tests
- [x] **New tests**:
   - `tests/parse-retry-after.test.ts` — 11 tests: valid messages, clamping bounds, edge cases (missing, empty, non-matching, negative)
   - `tests/rate-limit-unwrap.test.ts` — 15 tests: `rethrowIfRateLimit` shape/resetAt/fallback/passthrough, enrich `isRateLimitError` direct+wrapped detection, enrich `handleRateLimitError` parsing
   - `tests/temporal-sync-workflow.test.ts` — 2 new tests: delete churn integration (no further deletes after rate-limit hit until sleep completes, retry ordering), fetch unwrap integration
   - `tests/temporal-enrich-workflow.test.ts` — added stub `ActivityFailure`/`ApplicationFailure` to mock to prevent `instanceof` TypeError from new checks
- [ ] **Integration test**: Run `pnpm dev sync` against Temporal workflow and verify rate limits cause durable sleeps (visible in `workflow status --watch` via `nextRateLimitReset` field)
- [x] `pnpm test` — 282 pass, 2 skipped
- [x] `pnpm lint` — 0 errors
- [x] `pnpm typecheck` — clean

## Backlog

Items considered during planning but deferred to reduce blast radius. Revisit as needed.

| Item | Rationale | Notes |
| --- | --- | --- |
| Activity output type redesign (`rateLimited`/`rateLimitResetAt` fields) | Adds fields across `DeleteBookmarkOutput`, `FetchBookmarksOutput`, `EnrichRecordOutput` and corresponding activity catch blocks — large surface area for the same fix achieved by unwrapping | Would be cleaner if activities need to return rate-limit metadata for other reasons in the future |
| Circuit breaker in `process.ts` / `backlog.ts` | Defense-in-depth (abort after N consecutive delete failures) but can stop valid progress during transient API instability | Gate behind config if added; ship separately from the rate-limit fix |
| `fetchTweetDetails` rate-limit return variant | Original plan added `'rate-limited'` kind to `FetchTweetDetailsResult` and plumbed through `enrichRecord` in `store.ts` | Covered by enrich `isRateLimitError` fix — activity continues to throw, workflow detects it |
| ~~Parse `retryAfterMs` from error message in enrich path~~ | ~~Currently falls back to 15s default when `retryAfterMs` is missing~~ | **Promoted to implementation** — shared `parseRetryAfterMs` in `src/temporal/workflows/parse-retry-after.ts`, used by both sync and enrich paths (feedback tweak #1 and #2) |
| Fetch path rate-limit detection | Same latent bug exists for fetch activities, but missed rate-limit detection tends to fail the workflow (fetch phase re-throws) rather than silently continuing like deletes | Fixed by change #3 (fetch adapter gets `rethrowIfRateLimit` too) but lower severity than delete path |

## Feedback

- Keep fix scope small for live safety — fix error detection/unwrapping, not activity return contracts
- `Date.now()` must not appear in workflow code — use `workflowNowMs()` for determinism
- Circuit breaker can stop valid progress during transient instability — gate behind config if shipped
- Fetch path is latent but lower severity (fails workflow vs silently continuing)
- `nonRetryableErrorTypes: ['RateLimitError']` stays as-is — no downside
- 3 tweaks before implementation:
  1. Make `parseRetryAfterMs` robust and bounded — clamp to [1s, 24h], handle missing/malformed/non-positive input gracefully
  2. Reuse one shared parser for both sync and enrich paths — single `src/temporal/workflows/parse-retry-after.ts` imported by both
  3. Add one integration assertion specifically for delete churn — verify no further delete attempts after first rate-limit hit until sleep completes

## Action Items

- [ ] Manual integration test against live Temporal workflow (verification item above)

## Notes

## Review Findings (2026-02-20)

### High

- None.

### Medium

- None.

### Low

- `src/temporal/workflows/parse-retry-after.ts:10` uses a case-sensitive pattern (`/Retry after (\d+)s/`). Current behavior is safe because fallback to `DEFAULT_RATE_LIMIT_WAIT_MS` still prevents churn, but if upstream message casing/wording changes, timing precision degrades to fallback sleep.
- `tests/temporal-sync-workflow.test.ts` and `tests/rate-limit-unwrap.test.ts` both define custom Temporal error mock classes with symbol markers. This duplication is acceptable, but consolidating into a shared test helper would reduce drift risk.

### Verification Summary

- `pnpm test -- tests/rate-limit-unwrap.test.ts tests/parse-retry-after.test.ts tests/temporal-sync-workflow.test.ts tests/temporal-enrich-workflow.test.ts` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- All test suites currently pass end-to-end (`27 passed, 1 skipped`).

### Implementation notes for reviewer

**Files changed (production):**
- `src/temporal/workflows/parse-retry-after.ts` (new) — shared parser with [1s, 24h] clamping
- `src/temporal/workflows/sync/rate-limit.ts` — added `rethrowIfRateLimit()` using shared parser + `workflowNowMs()`
- `src/temporal/workflows/sync/runtime.ts` — try-catch in `fetchBookmarks` and `deleteBookmark` with `rethrowIfRateLimit`
- `src/temporal/workflows/enrich/rate-limit.ts` — `isRateLimitError` detects wrapped errors; new `extractRetryAfterMs` uses shared parser

**Files changed (tests):**
- `tests/parse-retry-after.test.ts` (new) — 11 tests
- `tests/rate-limit-unwrap.test.ts` (new) — 15 tests; mock classes use `Symbol.for` markers matching Temporal's `@SymbolBasedInstanceOfError` pattern for real `instanceof` behavior
- `tests/temporal-sync-workflow.test.ts` — mock classes moved inside `vi.hoisted`; added delete churn and fetch unwrap tests
- `tests/temporal-enrich-workflow.test.ts` — added stub error classes to mock

**Key decisions:**
- Imports use `import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow'` (named) alongside `import * as wf` (namespace) — both from same package, biome sorts namespace first
- Test mocks use `Symbol.for('__temporal_isActivityFailure')` markers + custom `Symbol.hasInstance` to match Temporal SDK's cross-realm instanceof behavior; plain class extends wouldn't work because `@temporalio/common` isn't directly importable under pnpm strict hoisting
- The enrich path now gets actual retry-after timing from parsed messages instead of always defaulting to 15s — this was a side effect of promoting the shared parser from backlog
