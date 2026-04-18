# Track Unavailable Tweets During Enrichment

## Context

During enrichment, some stub tweets return HTTP 200 from the X API but with an empty data payload (suspended accounts, withheld content). Currently these stay as stubs (`full_json IS NULL`) and get re-attempted on every enrich run, wasting API calls. The user wants to keep the records (accounts may come back), track them separately, show them distinctly on the status page, and have a way to periodically retry them.

## Approach

Add a single `unavailable_at` column to the `tweets` table. This is orthogonal to the completeness system — a tweet can be a stub AND unavailable. The main enrich workflow automatically skips unavailable tweets. Retry uses `--retry-unavailable` flag on the existing enrich workflow.

## Changes

### 1. Schema & DB layer — `src/lib/db.ts`

- Add `unavailable_at TEXT` column via safe migration in `init()` (same pattern as existing `ensureSourceColumn`)
- Modify `getTweetsNeedingEnrichment()`: add `AND unavailable_at IS NULL` to the WHERE clause
- Add `markTweetUnavailable(tweetId)`: sets `unavailable_at = now`
- Add `clearTweetUnavailable(tweetId)`: sets `unavailable_at = NULL`
- Add `getUnavailableTweets(limit)`: queries `WHERE full_json IS NULL AND unavailable_at IS NOT NULL ORDER BY unavailable_at ASC`
- Modify `getTweetCompletenessStats()`: return `unavailable` count separately, subtract from stubs

### 2. Type — `src/types/index.ts`

- Add `unavailable_at: string | null` to `DbTweet` interface (line 222)

### 3. Enrich activity — `src/temporal/activities/store.ts`

- In `enrichRecord`: when `fetchTweetDetails` returns null (line 139-148), call `db.markTweetUnavailable(input.tweetId)`
- On success: if `existing.unavailable_at` is set, call `db.clearTweetUnavailable(input.tweetId)` (handles retry-succeeds case)

### 4. Local enrich path — `src/commands/sync-adapter.ts`

- Same pattern in `enrichRecord()` (line 171-173): call `this.db.markTweetUnavailable(tweetId)` when `details` is null
- On success: clear unavailable if previously set

### 5. Query activities — `src/temporal/activities/query.ts`

- Add `getUnavailableRecords(input: { limit: number })` activity — calls `db.getUnavailableTweets()`
- Add `getUnavailableCount()` activity — calls `db.getTweetCompletenessStats().unavailable`
- `getStubCount()` already calls `getTweetCompletenessStats().stubs` which will auto-exclude unavailable after step 1
- Register new activities in `src/temporal/activities/index.ts`

### 6. Shared types — `src/temporal/shared/types.ts`

- Add `retryUnavailable?: boolean` to `EnrichWorkflowInput`
- Add `unavailable: number` to `EnrichProgress` and `EnrichWorkflowResult`

### 7. Enrich workflow — `src/temporal/workflows/enrich.ts`

- Add `getUnavailableRecords`, `getUnavailableCount` to proxied activities
- Add `let unavailable = 0` state variable
- When `input.retryUnavailable`: use `getUnavailableRecords`/`getUnavailableCount` instead of stub variants
- In processing loop: when `result.success === false`, increment `unavailable` counter
- Include `unavailable` in progress query and return value

### 8. CLI workflow command — `src/commands/workflow.ts`

- Add `--retry-unavailable` option to `workflow start` command (~line 60)
- Pass `retryUnavailable` into `EnrichWorkflowInput` (~line 157)
- In workflow status display (~line 334-345): show `Unavailable` line when `progress.unavailable > 0`

### 9. Status display — `src/commands/status.ts` + `src/lib/notifications.ts`

- In `status.ts`: pass `unavailable` count from `db.getTweetCompletenessStats()` to `showCompletenessSummary`
- In `notifications.ts`: add optional `unavailable?: number` to `CompletenessNotification`, show as yellow line when > 0

## Usage

```bash
# Normal enrich — skips unavailable tweets
pnpm dev workflow start enrich --limit 100

# Retry unavailable tweets
pnpm dev workflow start enrich --retry-unavailable --limit 50

# Status shows unavailable count
pnpm dev status
# Data Completeness:
#   ████████████████████ 97% complete
#   81 complete, 0 stubs, 0 partial
#   2 unavailable (suspended/withheld)
```

## Verification

1. `pnpm typecheck` — passes
2. `pnpm test` — passes (add tests for new DB methods and enrichRecord unavailable marking)
3. `pnpm lint` — passes
4. Manual: run `pnpm dev:worker` + `pnpm dev workflow start enrich` and confirm the 2 previously-failing tweets get marked unavailable instead of retried
5. Manual: `pnpm dev status` shows unavailable count
6. Manual: `pnpm dev workflow start enrich --retry-unavailable` targets only unavailable tweets

## Tests to add

- `tests/db.test.ts`: `markTweetUnavailable`, `clearTweetUnavailable`, `getUnavailableTweets`, updated `getTweetCompletenessStats`, `getTweetsNeedingEnrichment` excludes unavailable
- `tests/temporal-activities.test.ts`: `enrichRecord` marks tweet unavailable on null fetch, clears on retry success
