# Plan: Remove Tier-Based Rate Limiting (Phase 2)

## Context

X API migrated from tiered subscriptions (Free: 1 req/15min, Paid: 5 req/15min) to pay-per-usage credits with much higher stability-based rate limits (450-3,500 req/15min). The artificial interval-based throttling and `ApiTier` concept are now redundant. This is Phase 2 from the pricing assessment doc — the rate limiter refactoring that can proceed immediately without API verification tests.

## Approach

Replace interval-based throttling with a minimal default delay (250ms between requests) and keep header-based rate limit tracking (still needed for 429 handling). Remove the `ApiTier` type and all free/paid branching.

### Key Design Decisions

- **Keep `RateLimiter` class** — still needed for header-based tracking, pause/resume, countdown display, and state persistence
- **Keep `syncIntervalMs` in Config** — but change the default from 900s/180s to 250ms. The `SYNC_INTERVAL_MS` env var still works as an override
- **Remove `ApiTier` type entirely** — no more free/paid distinction; `config.apiTier` removed
- **Remove `canFetchTweetDetails` tier gating** — all users can now fetch tweet details
- **Default 429 fallback: 60s instead of 15min** — reasonable safety net when no reset header present
- **Workflow default wait: 60s instead of 15min** — same reasoning
- **Delete queue backoff: 2s base, 30s max** — down from 60s base, 60min max

## Changes by File

### 1. `src/types/index.ts`

- Remove `ApiTier` type (line 332)
- Remove `apiTier` from `Config` interface (line 342)

### 2. `src/lib/config.ts`

- Remove `DEFAULT_FREE_INTERVAL_MS` and `DEFAULT_PAID_INTERVAL_MS` constants
- Add `DEFAULT_SYNC_INTERVAL_MS = 250`
- Remove `getApiTier()` function
- Remove `getSyncIntervalMs()` tier logic — simplify to env override or default
- Remove `apiTier` from `loadConfig()` return

### 3. `src/lib/rate-limiter.ts`

- No structural changes needed — the interval-based logic is still used (now with 250ms instead of 15min)
- Remove persistence to `data/rate-limit.json` (250ms intervals don't need to survive restarts)

### 4. `src/lib/api.ts`

- Change 429 fallback from `15 * 60 * 1000` to `60 * 1000` (line 229)

### 5. `src/temporal/workflows/sync.ts`

- Change `DEFAULT_RATE_LIMIT_WAIT_MS` from `15 * 60 * 1000` to `60 * 1000` (line 61)
- Update comment

### 6. `src/temporal/workflows/enrich.ts`

- Change `DEFAULT_RATE_LIMIT_WAIT_MS` from `15 * 60 * 1000` to `60 * 1000` (line 34)
- Update comment

### 7. `src/sources/x-api.ts`

- Remove `isPaid` branching (lines 81-84)
- Set `name` to `'x-api'` (single name, no tier suffix)
- Set `description` to `'Official X (Twitter) API v2'`
- Set `canFetchTweetDetails: true` (no longer tier-gated)
- Import single risk profile key

### 8. `src/lib/notifications.ts`

- Merge `RISK_PROFILES['x-api-free']` and `['x-api-paid']` into single `'x-api'` entry
- Update `SourceName` type

### 9. `src/commands/sync.ts`

- Remove `API Tier` display line (line 172)
- Remove `Interval` display line (line 173) — 250ms not useful to display
- `createRateLimiter(config.syncIntervalMs)` still works (no change needed)

### 10. `src/lib/db.ts`

- Change `DELETE_QUEUE_BASE_BACKOFF_MS` from `60_000` to `2_000`
- Change `DELETE_QUEUE_MAX_BACKOFF_MS` from `60 * 60 * 1000` to `30_000`

### 11. `.env.example`

- Remove `API_TIER` section (lines 15-18)
- Update `SYNC_INTERVAL_MS` comment (remove tier defaults)

### 12. `src/index.ts`

- No changes needed (exports remain the same)

### 13. Test files

**`tests/rate-limiter.test.ts`** — No structural changes, tests still valid with smaller intervals

**`tests/x-api-source.test.ts`**:

- Remove `apiTier` from `baseConfig`
- Remove `'should gate tweet details on free tier'` test
- Update capability expectations (name: `'x-api'`, `canFetchTweetDetails: true`)

**`tests/api.test.ts`**:

- Remove `apiTier` from `mockConfig`

**`tests/temporal-fetch-activities.test.ts`**:

- No changes needed (doesn't reference apiTier directly)

### 14. `CLAUDE.md`

- Update "X API Limitations" section: remove free/paid tier references
- Update rate limit documentation

### 15. `README.md`

- Remove `API_TIER` from env var table (line 78)
- Update `SYNC_INTERVAL_MS` description

## Verification

1. `pnpm typecheck` — confirm no type errors after removing ApiTier
2. `pnpm lint` — confirm code style
3. `pnpm test` — all tests pass
4. `pnpm build` — compiles successfully
