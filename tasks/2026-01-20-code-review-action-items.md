# Implementation Plan: Code Review Items

## Priority Order

1. **Implement fetchTweetDetails** - Smallest scope, unblocks enrichment workflow
2. **Header-based rate limiting** - Foundation improvement, isolated changes
3. **Comprehensive unit tests** - Validates behavior before SyncEngine refactor
4. **Extract SyncEngine** - Largest scope, benefits from tests in place

---

## 1. Implement fetchTweetDetails

### Files to Modify

- `src/lib/api.ts` - Add `getTweet()` method
- `src/sources/x-api.ts` - Implement `fetchTweetDetails()`, set `canFetchTweetDetails: true`

### Steps

1. Add `getTweet(tweetId)` method to `XApiClient`:
   - Call `GET /2/tweets/:id` with same expansions as `getBookmarks()`
   - Handle 429 with `checkRateLimit()`
   - Return `{ tweet, users, media }`

2. Implement `XApiDataSource.fetchTweetDetails()`:
   - Call `client.getTweet(tweetId)`
   - Return null for deleted/protected tweets (404/403)
   - Re-throw `RateLimitError` for workflows to handle

3. Update capabilities: `canFetchTweetDetails: true`

### Verification

```bash
pnpm dev sync <folder-id> --no-delete --limit 1  # Create stub
pnpm dev workflow start enrich --limit 1          # Enrich it
```

---

## 2. Header-Based Rate Limiting

### Files to Modify

- `src/lib/rate-limiter.ts` - Add header-based state
- `src/lib/api.ts` - Extract and pass headers after each response
- `src/sources/x-api.ts` - Wire rate limiter to API client
- `src/commands/sync.ts` - Connect rate limiter to data source

### Steps

1. Enhance `RateLimiter`:
   - Add `remaining`, `limit`, `resetAt` state
   - Implement `updateFromHeaders()` to update state
   - Modify `waitForNextSlot()` to use header-based info when remaining=0
   - Add `getState()` for inspection

2. Extract headers in `XApiClient`:
   - Add `setRateLimiter(limiter)` method
   - Add `extractRateLimitHeaders(response)` helper
   - Call `limiter.updateFromHeaders()` after every response (success or 429)

3. Wire in sync command:
   - Connect rate limiter to API client via data source

### Verification

```bash
LOG_LEVEL=debug pnpm dev sync --no-folders --limit 2
# Observe header values in debug output
```

---

## 3. Comprehensive Unit Tests

### New Test Files

```text
tests/
  rate-limiter.test.ts   # Time-based, header-based, pause/resume
  api.test.ts            # Mock fetch, test response parsing, 429 handling
  x-api-source.test.ts   # Test mapping functions
  activities/
    store.test.ts        # Full vs stub storage
    query.test.ts        # Backlog queries, verification
```

### Key Test Patterns

- Use `vi.useFakeTimers()` for RateLimiter tests
- Mock `global.fetch` for API tests
- Use real SQLite for activity tests (like existing db.test.ts)
- Table-driven tests for data mapping

### Priority Tests

1. `rate-limiter.test.ts`:
   - Time-based interval enforcement
   - Header update behavior
   - Pause/resume state
   - Wait-until-reset when remaining=0

2. `api.test.ts`:
   - Successful response parsing
   - 429 throws RateLimitError with correct retryAfterMs
   - Header extraction

3. `activities/store.test.ts`:
   - Full tweets stored with full_json
   - Stubs stored without full_json
   - COALESCE preserves existing data

### Verification

```bash
pnpm test
pnpm test:coverage  # Aim for 80%+ on lib/ and activities/
```

---

## 4. Extract SyncEngine

### New Files

- `src/lib/sync-engine.ts` - Core engine with 4-phase flow
- `src/commands/sync-adapter.ts` - CLI implementation
- `src/temporal/workflows/sync-adapter.ts` - Temporal implementation

### Files to Modify

- `src/commands/sync.ts` - Use SyncEngine
- `src/temporal/workflows/sync.ts` - Use SyncEngine

### Interface Design

```typescript
interface SyncOperations {
  fetchBookmarks(options): Promise<FetchBookmarksResult>;
  storeBookmarks(input): Promise<StoreBookmarksOutput>;
  deleteBookmark(tweetId): Promise<boolean>;
  verifyBookmarkForDelete(tweetId, folderId): VerifyResult;
  getDeleteBacklog(folderId): DbBookmark[];
  waitForRateLimit(): Promise<void>;
  handleRateLimitError(error): Promise<void>;
  isPaused(): boolean;
  isCancelled(): boolean;
  waitWhilePaused(): Promise<void>;
}
```

### Migration Steps

1. Create `SyncEngine` class with shared 4-phase logic
2. Create `CliSyncOperations` adapter
3. Refactor `commands/sync.ts` to use engine
4. Create `TemporalSyncOperations` adapter
5. Refactor `workflows/sync.ts` to use engine
6. Remove duplicated code

### Verification

```bash
# Before/after comparison
pnpm dev sync --no-folders --limit 5 > before.txt
# After refactor
pnpm dev sync --no-folders --limit 5 > after.txt
diff before.txt after.txt
```

---

## Summary of Changes

| Area | Files | Scope |
| --- | --- | --- |
| Enrichment | api.ts, x-api.ts | ~100 lines added |
| Rate Limiting | rate-limiter.ts, api.ts, x-api.ts, sync.ts | ~80 lines modified |
| Tests | 4-5 new test files | ~400 lines added |
| SyncEngine | 3 new files, 2 modified | ~500 lines (net reduction after dedup) |

---

## Verification Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Enrichment workflow populates stub records
- [ ] Rate limit headers logged in debug mode
- [ ] CLI sync behavior unchanged after SyncEngine refactor
- [ ] Temporal workflow behavior unchanged after SyncEngine refactor
