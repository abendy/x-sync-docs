# X API Pricing Model Assessment

**Created:** 2026-02-03
**Status:** Complete
**Context:** X API migrated to pay-per-usage model; assess codebase for redundant code and test documented limitations

---

## Executive Summary

The X API has transitioned from a tiered subscription model (Free/Basic/Pro) to a **pay-per-usage credit system**. This fundamentally changes the constraints our architecture was built around:

| Old Model | New Model |
| --- | --- |
| Free: 1 req/15min | Pay-per-request (credits) |
| Paid: 5 req/15min | Rate limits still exist but are stability-based, not tier-based |
| Extreme scarcity | No monthly caps, no subscriptions |
| Required strategic rate limiting | Pay for what you use |

**Key insight:** Much of our codebase was built specifically to work around extreme rate-limit scarcity. Under pay-per-usage, this scaffolding may be redundant.

---

## New X API Pricing Model

### Credit-Based System

- **No subscriptions** - Purchase credits upfront in Developer Console
- **No monthly caps** - "Use as much as you need—no monthly limits"
- **Pay-per-use** - Different endpoints have different costs
- **Deduplication** - Same resource fetched multiple times in 24h UTC window counts as one charge
- **Spending controls** - Auto-recharge, spending limits, budget alerts

### Rate Limits (Still Exist)

Rate limits are **separate from billing** - they exist for system stability, not for tier gating:

| Endpoint Type | Rate Limit |
| --- | --- |
| Post lookups | 450-3,500 req/15min per app |
| Recent search | 450 req/15min per app |
| Full-archive search | 1/sec + 300 req/15min per app |
| User lookups | 300 req/15min per app |
| Direct messages | 15 req/15min per user |

**Key change:** The old 1-5 req/15min limit is gone. Current limits are orders of magnitude higher.

### Error Handling

- 429 "Too Many Requests" still indicates rate limit exceeded
- Response headers still provide: `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`
- Exponential backoff recommended for 429 and 5xx errors

---

## Codebase Assessment: Redundant Code

### 1. Rate Limiter Intervals (HIGH PRIORITY)

**Location:** `src/lib/rate-limiter.ts`, `src/lib/config.ts`

**Current Implementation:**

```typescript
// config.ts lines 7-8
const DEFAULT_FREE_INTERVAL_MS = 900000;  // 15 minutes
const DEFAULT_PAID_INTERVAL_MS = 180000;  // 3 minutes
```

**Why It's Redundant:**

- 15-minute artificial delays no longer needed
- Tier-based intervals no longer reflect API reality
- Current rate limits allow 450+ requests per 15 minutes

**Recommendation:**

- Remove interval-based throttling
- Keep header-based rate limit tracking for monitoring
- Replace with simple request queuing (e.g., 100ms between requests)

**Files affected:**

- `src/lib/rate-limiter.ts` (lines 84-96: wait logic)
- `src/lib/config.ts` (interval constants, tier selection)
- `src/temporal/workflows/sync.ts` (line 61: DEFAULT_RATE_LIMIT_WAIT_MS)
- `src/temporal/workflows/enrich.ts` (line 34: DEFAULT_RATE_LIMIT_WAIT_MS)
- `src/lib/api.ts` (line 229: hardcoded 15-min fallback on 429 without reset header)
- `src/commands/sync.ts` (line 172: displays `API Tier` in CLI output)
- `src/types/index.ts` (line 332: `ApiTier` type definition)
- `src/lib/notifications.ts` (lines 55-68: `RISK_PROFILES` with tier-specific entries)
- `src/sources/x-api.ts` (lines 81-95: tier-based name, description, capabilities)
- Local sync path also uses `config.syncIntervalMs` — not just Temporal workflows

---

### 2. Stub/Partial Tweet Pattern (NEEDS VERIFICATION)

**Location:** `src/lib/db.ts`, `src/lib/expectations.ts`, `src/lib/assessment.ts`

**Current Implementation:**

- Database stores "stub" records (tweet ID only, no `full_json`)
- Three completeness levels: `stub | partial | complete`
- `upsertPartialTweet()` uses COALESCE to preserve existing data
- Assessment utilities measure missing fields

**Why It Exists:**
The folder endpoint (`/2/users/:id/bookmarks/folders/:folder_id`) returns **only tweet IDs** - no expansions supported.

**Verification Required:**
This limitation may or may not still exist. If the new paid API supports expansions on folder endpoints, this entire pattern is unnecessary.

**Potential Removal (if folder endpoint supports expansions):**

- `db.upsertPartialTweet()` (~70 lines)
- `expectations.ts` (~136 lines or simplify)
- `assessment.ts` (~219 lines or simplify)
- CompletenessLevel type system
- Nullable schema fields

---

### 3. Enrichment Workflow (NEEDS VERIFICATION)

**Location:** `src/temporal/workflows/enrich.ts`, `src/temporal/activities/fetch.ts`

**Current Implementation:**

- Temporal workflow discovers stub records (`full_json IS NULL`)
- Fetches full tweet details via separate API call
- Handles rate limits with **15-minute durable sleeps**
- Supports pause/resume/cancel signals

**Why It Exists:**
To convert stub records (from folder endpoint) to complete records. Required because:

1. Folder endpoint only returned IDs
2. Rate limits made inline fetching infeasible
3. Needed durability across restarts

**Why It May Be Redundant:**

- If folder endpoint now supports expansions: **entirely unnecessary**
- Even if not, 15-minute sleeps are absurd under new rate limits
- Could be replaced with inline fetching during sync

**Files affected:**

- `src/temporal/workflows/enrich.ts` (235 lines)
- `src/temporal/activities/fetch.ts` (lines 59-92: fetchTweetDetails)
- `src/temporal/activities/store.ts` (lines 101-159: enrichRecord)
- `src/sources/selection.ts` (lines 75-82: selectEnrichmentSource)

---

### 4. Delete Queue with Exponential Backoff (MEDIUM PRIORITY)

**Location:** `src/lib/db.ts` (lines 109-121: delete_queue DDL, lines 168-177: backoff constants and formula)

**Current Implementation:**

```typescript
const DELETE_QUEUE_BASE_BACKOFF_MS = 60_000;      // 60 seconds
const DELETE_QUEUE_MAX_BACKOFF_MS = 60 * 60 * 1000; // 60 minutes

// Formula: 2^(min(attempts, 6) - 1) * 60_000 ms
```

**Why It's Redundant:**

- Based on 1-5 deletes per 15 minutes
- Current rate limits allow hundreds of deletes per 15 minutes
- Aggressive backoff no longer needed

**Recommendation:**

- Simplify to immediate retry with 1-2 second backoff
- Consider removing queue table entirely (inline deletes)

---

### 5. Dual Data Source Paths (NEEDS VERIFICATION)

**Location:** `src/sources/selection.ts`, `src/sources/x-api.ts`, `src/lib/api.ts`

**Current Implementation:**

- Different code paths for folder-scoped vs. global bookmarks
- Capability tracking: `bookmarkDataCompleteness` vs `folderBookmarkDataCompleteness`
- X API source declares folder endpoint as `ids_only`
- `api.ts` lines 243-246: `getBookmarks()` sends empty params `{}` for folder requests (encodes the limitation in the request construction)

**Why It Exists:**
Folder endpoint had different limitations than global endpoint.

**Potential Simplification:**
If folder endpoint supports full data, unify to single code path and remove dual capability tracking.

---

### 6. Placeholder Workflows (LOW PRIORITY - KEEP)

**Location:** `src/temporal/workflows/topic-monitor.ts`, `src/temporal/workflows/engagement-tracking.ts`

**Status:** Placeholder scaffolding with TODO comments

**Recommendation:** Keep as-is. These are for future features that become **more feasible** under pay-per-usage (can poll frequently without hitting limits).

---

## Endpoints to Test

### Critical Tests

| # | Endpoint | Test | Expected Old Behavior | Result (2026-02-07) |
| --- | --- | --- | --- | --- |
| 1 | `GET /2/users/:id/bookmarks/folders/:folder_id` | Add `tweet.fields`, `user.fields`, `expansions` params | Rejects with error | **Still rejects** (400: params not one of [id,folder_id]) |
| 2 | `GET /2/users/:id/bookmarks/folders` | Check for `meta.next_token` in response | No pagination | **Still no pagination**. Returns max 20 folders, no `next_token` |
| 3 | `DELETE /2/users/:id/bookmarks/:tweet_id` | Delete from one folder | Removes from ALL folders | **Confirmed global** — no per-folder delete endpoint exists |
| 4 | `GET /2/tweets/:id` | Fetch single tweet details | Rate limited at free tier | **900 req/15min** under pay-per-usage |

### Test Scripts

Scripts used for verification are in `.project/scripts/`:

| Script | Task | Command |
|--------|------|---------|
| `t1-1-folder-expansions.ts` | Folder endpoint with expansions | `pnpm tsx .project/scripts/t1-1-folder-expansions.ts [folder_id]` |
| `t1-2-folder-pagination.ts` | Folder list pagination | `pnpm tsx .project/scripts/t1-2-folder-pagination.ts` |
| `t1-4-rate-limits.ts` | Rate limits from headers | `pnpm tsx .project/scripts/t1-4-rate-limits.ts` |
| `check-rate-reset.ts` | Quick rate limit reset check | `pnpm tsx .project/scripts/check-rate-reset.ts` |

> **Note:** All scripts are read-only (GET requests only). They reuse the existing auth infrastructure (tokens from `data/tokens.json`).

### Observed Rate Limits (pay-per-usage tier, 2026-02-07)

| Endpoint | Old Limit | New Limit | Window |
|----------|-----------|-----------|--------|
| Bookmarks (global) | 1-5/15min | **180**/15min | 15min |
| Folder list | 1/15min | **50**/15min | 15min |
| Folder bookmarks | 1/15min | **50**/15min | 15min |
| Tweet lookup | 1-5/15min | **900**/15min | 15min |
| User lookup | 1-5/15min | **75**/15min | 15min |

> **Important:** Rate limits only update after switching to pay-per-usage in the developer portal. Stale tokens from the old tier still return old limits (e.g., `x-rate-limit-limit: 1`). Re-auth after tier change is required.

---

## Documented Limitations to Re-verify

### From `docs/issues/folder-endpoint-limitation.md`

**Claimed Limitation:**
> The folder bookmarks endpoint does NOT support query parameters that the main bookmarks endpoint supports.

**Result (2026-02-07):** **CONFIRMED** — still rejects all expansion params with 400 error. Only `id` and `folder_id` are valid. This is an API design limitation, not tier-related. Stub/partial/enrichment pattern remains necessary.

---

### From `docs/issues/folder-pagination.md`

**Claimed Limitation:**
> The folder list endpoint does NOT support pagination. Returns max ~20 folders.

**Result (2026-02-07):** **CONFIRMED** — returns max 20 folders, no `meta.next_token`. `max_results` is accepted but pagination does not exist. Accounts with ~100 folders cannot retrieve all via API. Manual `folder add` workaround still required.

---

### From `docs/issues/multi-folder-bookmarks.md`

**Claimed Limitation:**
> DELETE endpoint removes bookmarks globally, not per-folder.

**Result (2026-02-07):** **CONFIRMED** — no per-folder delete endpoint exists in the X API docs. This is a design decision, not a tier limitation.

---

## Refactoring Tasks

### Phase 1: Verify Limitations

- [x] **T1.1** Test folder endpoint with expansions/fields — **STILL REJECTS** (400: params not one of [id,folder_id]). Not tier-related; API design limitation.
- [x] **T1.2** Test folder list pagination — **STILL NO PAGINATION**. Returns max 20 folders, no `meta.next_token`. `max_results` accepted but no next token even with `max_results=1`.
- [x] **T1.3** Test delete behavior across folders — **CONFIRMED**: no per-folder delete endpoint exists in the API. Global delete by design.
- [x] **T1.4** Document current rate limits from headers — **DONE**. Pay-per-usage limits: Bookmarks 180/15min, Folders 50/15min, Tweet lookup 900/15min, User lookup 75/15min.

### Phase 2: Rate Limiter Refactoring (Can Start Immediately)

- [x] **T2.1** Remove 15-minute interval logic from rate-limiter.ts
- [x] **T2.2** Remove tier-based interval constants from config.ts
- [x] **T2.3** Update workflow default wait times (sync.ts line 61, enrich.ts line 34)
- [x] **T2.4** Simplify delete queue backoff (60s → 1-2s base)
- [x] **T2.5** Update CLAUDE.md rate limit documentation
- [x] **T2.6** Reduce hardcoded 15-min 429 fallback in api.ts (line 229)
- [x] **T2.7** Remove `ApiTier` type and all tier branching (`types/index.ts`, `config.ts`, `x-api.ts`, `notifications.ts`, `sync.ts` CLI display)
- [x] **T2.8** Update test files with hardcoded tier assumptions (`tests/x-api-source.test.ts`, `tests/temporal-fetch-activities.test.ts`, `tests/api.test.ts`)

### Phase 3: Conditional Refactoring (After Phase 1 Tests)

**~~If folder endpoint supports expansions:~~** *(ruled out — endpoint still ID-only)*

- ~~**T3.1** Remove `upsertPartialTweet()` from db.ts~~
- ~~**T3.2** Simplify or remove expectations.ts~~
- ~~**T3.3** Simplify or remove assessment.ts~~
- ~~**T3.4** Delete enrichment workflow entirely~~
- ~~**T3.5** Remove enrichment activities (fetchTweetDetails, enrichRecord)~~
- ~~**T3.6** Unify data source paths (remove dual completeness tracking)~~
- ~~**T3.7** Make `full_json` NOT NULL in schema~~
- ~~**T3.8** Update ADRs: 007 (nullable schema), 010 (expectations-based completeness), 011 (Temporal workflow engine)~~

**Folder endpoint still ID-only** *(confirmed path)*:

- [x] **T3.9** Keep enrichment workflow but simplify rate limiting — reduced `DEFAULT_RATE_LIMIT_WAIT_MS` from 60s to 15s in `api.ts`, `sync.ts`, `enrich.ts`
- [x] **T3.10** Update enrichment workflow intervals — bumped default batch size from 10 to 100 (can process up to 900 tweet lookups per 15min window)
- [x] **T3.11** Document new cost model for enrichment operations — created `docs/cost-model.md` with request counts per operation, throughput estimates, and cost comparison vs old model

### Phase 4: Documentation Updates

- [x] **T4.1** Update `docs/issues/folder-endpoint-limitation.md` with test results
- [x] **T4.2** Update `docs/issues/folder-pagination.md` with test results
- [x] **T4.3** Create new ADR for pay-per-usage migration — `docs/adr/018-pay-per-usage-migration.md`
- [x] **T4.4** Update CLAUDE.md "X API Limitations" section
- [x] **T4.5** Remove free/paid tier references throughout docs

---

## Actual Lines of Code Removed/Changed

**Phase 2 (completed):** Tier-based rate limiting removal

| File | Lines | Change |
| --- | --- | --- |
| Rate limiter wait logic | ~30 | Removed artificial delays |
| Delete queue backoff | ~20 | Simplified retry |
| Tier branching (`ApiTier`, config, notifications, x-api) | ~40 | Removed free/paid distinction |
| **Total** | **~90** | Tier scaffolding removed |

**Phase 3 (maximum cleanup path ruled out):** Folder endpoint still returns IDs only, so enrichment workflow, stub/partial pattern, expectations, and assessment code all remain necessary.

---

## Migration Considerations

### Cost Model Change

**Old Model:** Time was the constraint (1 req/15min = ~100 tweets/day max)
**New Model:** Money is the constraint (pay per request/resource)

**New Questions:**

- What does a full sync cost in credits?
- What does enrichment cost per record?
- Should we add cost tracking/estimation?

### Breaking Changes

None expected - this is a simplification that removes unnecessary complexity. External behavior (CLI, Temporal workflows) remains the same.

### Rollback Plan

If testing reveals unexpected behavior:

1. Keep rate-limiter changes behind feature flag
2. Preserve old workflow code in separate branch
3. Can restore interval-based limiting if needed

---

## Next Steps

All phases complete as of 2026-02-13.

1. ~~**Review this document** - confirm scope and priorities~~
2. ~~**Run Phase 1 tests** - verify current API behavior~~
3. ~~**T3.9–T3.11** - Simplify enrichment workflow rate limiting (15min → 15s intervals)~~
4. ~~**T4.3** - Create new ADR for pay-per-usage migration~~
5. ~~**Execute remaining refactoring** - based on confirmed test results~~

---

## References

- [X API Pricing](https://docs.x.com/x-api/getting-started/pricing)
- [X API Rate Limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X API Post Cap](https://docs.x.com/x-api/fundamentals/post-cap)
- [X API Error Codes](https://docs.x.com/x-api/fundamentals/response-codes-and-errors)
- [ADR 002: Rate Limiting Strategy](/docs/adr/002-rate-limiting.md)
- [ADR 007: Nullable Schema](/docs/adr/007-nullable-schema-for-partial-data.md)
- [ADR 010: Expectations-Based Completeness](/docs/adr/010-expectations-based-data-completeness.md)
- [ADR 011: Temporal Workflow Engine](/docs/adr/011-temporal-workflow-engine.md)
- [Issue: Folder Endpoint Limitation](/docs/issues/folder-endpoint-limitation.md)
- [Issue: Folder Pagination](/docs/issues/folder-pagination.md)
- [Issue: Multi-Folder Bookmarks](/docs/issues/multi-folder-bookmarks.md)
