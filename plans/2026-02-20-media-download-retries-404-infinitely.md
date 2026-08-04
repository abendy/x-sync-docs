# Plan: Media download retries 404 infinitely

**Status:** Complete
**Created:** 2026-02-20
**Source:** ~/.claude/plans/tidy-popping-barto.md

## Context

A media download workflow retried an HTTP 404 (media key `3_1940423112568274944`) hundreds of times across multiple `continueAsNew` cycles for ~8 minutes. The root cause: when a download fails, the DB is never updated, so `getDownloadableMedia()` (which filters `WHERE local_path IS NULL`) keeps returning the same record on every pass.

## Approach

Add a `download_error` column to the `media` table. When a download fails with a permanent HTTP error (4xx except 429), mark the record with the error. Update queries to exclude records with `download_error IS NOT NULL`. Add a `not_found` outcome to distinguish permanent failures from transient ones.

This follows the existing enrichment pattern where `unavailable` is a distinct outcome from `failed`.

## Changes

### 1. DB: Add `download_error` column — `src/lib/db/media-repo.ts`

- Add `ensureDownloadErrorColumn()` following the `ensureLocalPathColumn()` pattern
- Add `setDownloadError(mediaKey: string, error: string)` method
- Update `getDownloadableMedia()` query: add `AND download_error IS NULL`
- Update `getDownloadableMediaCount()` query: add `AND download_error IS NULL`

### 2. DB client: Wire new methods — `src/lib/db/client.ts`

- Call `mediaRepo.ensureDownloadErrorColumn()` in `init()` (after `ensureLocalPathColumn`)
- Add `setMediaDownloadError(mediaKey, error)` delegate method

### 3. DB type: Add field — `src/types/db.ts`

- Add `download_error: string | null` to `DbMedia` interface

### 4. Activity types: Add outcome — `src/temporal/shared/activity-types.ts`

- Add `'not_found'` to `DownloadMediaOutput.outcome` union: `'downloaded' | 'skipped' | 'not_found' | 'failed'`

### 5. Download activity: Classify errors — `src/temporal/activities/download.ts`

- In `downloadMedia()` catch block, parse the error message for HTTP status
- If status is 4xx (except 429): call `db.setMediaDownloadError(mediaKey, message)`, return `{ outcome: 'not_found' }`
- Otherwise: return `{ outcome: 'failed' }` as before (transient errors)

### 6. Workflow types: Add `notFound` counter — `src/temporal/shared/media-download-types.ts`

- Add `notFound: number` to `MediaDownloadCarryForward`
- Add `notFound: number` to `MediaDownloadWorkflowResult`
- Add `notFound: number` to `MediaDownloadProgress`

### 7. Workflow runtime state — `src/temporal/workflows/media-download/runtime.ts`

- Add `notFound: number` to `MediaDownloadRuntimeState`
- Initialize from carry-forward or 0 in `createMediaDownloadRuntimeState()`
- Include in `progressQuery` handler response

### 8. Workflow pass: Handle new outcome — `src/temporal/workflows/media-download/pass.ts`

- Add `else if (result.outcome === 'not_found')` branch that increments `state.notFound++`

### 9. Workflow index: Thread `notFound` through — `src/temporal/workflows/media-download/index.ts`

- Include `notFound` in `effectiveLimit` calculation: `carryForward.downloaded + carryForward.failed + carryForward.skipped + carryForward.notFound`
- Include `notFound` in result object
- Include `notFound` in `_carryForward` object
- Add `notFound` to `isValidCarryForward` check

### 10. Tests

**`tests/download-activity.test.ts`:**
- Add mock for `setMediaDownloadError`
- Add test: HTTP 404 returns `{ outcome: 'not_found' }` and calls `setMediaDownloadError`
- Add test: HTTP 500 still returns `{ outcome: 'failed' }` (transient)
- Add test: network error still returns `{ outcome: 'failed' }` (transient)

**`tests/media-repo.test.ts`:**
- Add tests for `ensureDownloadErrorColumn` (column exists after init)
- Add test: `setDownloadError` marks record, excludes from `getDownloadableMedia`
- Add test: `getDownloadableMediaCount` excludes records with download_error

**`tests/media-download-workflow.test.ts`:**
- Add `notFound` to mock activity responses and state assertions where needed

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm test` — all tests pass
3. `pnpm lint` — no lint issues

## Notes

## Code Review Findings (2026-02-20)

### High

- None.

### Medium

- **Carry-forward compatibility break for in-flight workflow chains**  
  `isValidCarryForward()` now requires `notFound` to exist, so any continue-as-new payload created by the previous code version (without `notFound`) is treated as invalid and dropped. This resets counters/duration context and can miscompute `limit` for that continuation.  
  Reference: `src/temporal/workflows/media-download/index.ts:42`

- **`not_found` classification is coupled to error-message text format**  
  The permanent-error branch parses `error.message` via regex (`/HTTP (\d+)/`) instead of classifying from structured status data. If the thrown message format changes, 404s can silently fall back to `failed`, reintroducing repeated retries for permanent misses.  
  Reference: `src/temporal/activities/download.ts:16`, `src/temporal/activities/download.ts:127`

### Low

- **Terminal suppression has no explicit reset path when media metadata changes**  
  Once `download_error` is set, `getDownloadableMedia*()` permanently excludes that row. If upstream data later changes (for example URL refresh/rewrite), there is no corresponding clear step in `upsertMedia()` to re-eligible previously terminal records.  
  References: `src/lib/db/media-repo.ts:56`, `src/lib/db/media-repo.ts:64`, `src/lib/db/media-repo.ts:75`
