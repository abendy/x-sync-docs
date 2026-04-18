# Media Download Workflow

## Context

Tweet media URLs stored in the `media` table are remote CDN links that can expire or become unavailable. A new Temporal workflow — modeled after EnrichWorkflow — will discover media records with photo URLs and download the actual image files to local disk. This ensures long-term access to bookmarked tweet images regardless of API/CDN availability.

**Scope**: Photos only (`type = 'photo'`, using the `url` field). No videos, GIFs, or profile images in this iteration.

**Integration**: Both standalone (`pnpm dev workflow start media-download`) and as a child workflow from SyncWorkflow (same pattern as enrich).

## Database Changes

### Add `local_path` column to `media` table

Use the same `ensureColumns()` migration pattern from `TweetMaintenanceRepo`:

- **File**: `src/lib/db/media-repo.ts`
- Add `ensureLocalPathColumn()` method that runs `ALTER TABLE media ADD COLUMN local_path TEXT`
- Called during DB initialization alongside existing `ensureColumns()` calls
- Records with `local_path IS NULL AND url IS NOT NULL AND type = 'photo'` are candidates for download

### New query methods on `MediaRepo`

- `getDownloadableMedia(limit: number)` — returns media records where `type = 'photo' AND url IS NOT NULL AND local_path IS NULL`
- `getDownloadableMediaCount()` — count of above
- `setLocalPath(mediaKey: string, localPath: string)` — updates `local_path` after successful download

## File Storage

- **Directory**: `data/media/<tweet_id>/` — groups all media for a tweet together
- **Filename**: `<media_key>.<ext>` — extension derived from URL (`.jpg`, `.png`) with `.jpg` fallback
- Activity creates directories with `fs.mkdirSync(dir, { recursive: true })`
- Config: add `MEDIA_DIR` env var to config (default: `./data/media`)

## Workflow: `mediaDownloadWorkflow`

### Structure (mirrors EnrichWorkflow)

```text
src/temporal/workflows/media-download/
  index.ts        — main workflow function + re-exports
  signals.ts      — pause/resume/cancel/trigger/drainAndExit signals + progress query
  runtime.ts      — MediaDownloadRuntimeState, handlers, waitWhilePaused
  activities.ts   — proxyActivities config (longer timeout for downloads)
  loop.ts         — runMediaDownloadLoop (same trigger/single-pass pattern as enrich)
  pass.ts         — processSinglePass (iterate batch, call downloadMedia activity)
```

### Types

**File**: `src/temporal/shared/media-download-types.ts`

```ts
interface MediaDownloadWorkflowInput {
  limit?: number;
  batchSize?: number;
  awaitTriggers?: boolean;    // for child workflow mode
}

interface MediaDownloadWorkflowResult {
  downloaded: number;
  failed: number;
  skipped: number;
  remaining: number;
  durationMs: number;
}

interface MediaDownloadProgress {
  downloaded: number;
  failed: number;
  skipped: number;
  remaining: number;
  currentMediaKey?: string;
  lastError?: string;
}
```

### Activity Proxy Config

```ts
wf.proxyActivities<...>({
  startToCloseTimeout: '2 minutes',  // downloads may be slow
  retry: { maximumAttempts: 3 },
});
```

No rate limit error handling needed — CDN downloads don't have X API rate limits.

## Activities

### New file: `src/temporal/activities/download.ts`

**`getDownloadableMedia(input: { limit: number })`**

- Query activity — calls `MediaRepo.getDownloadableMedia(limit)`
- Returns `{ media: Array<{ mediaKey, tweetId, url }> }`

**`getDownloadableMediaCount()`**

- Query activity — calls `MediaRepo.getDownloadableMediaCount()`

**`downloadMedia(input: { mediaKey, tweetId, url, mediaDir })`**

- Downloads image from URL using Node.js built-in `https`/`http` modules (no new dependencies)
- Creates directory `<mediaDir>/<tweetId>/`
- Writes file as `<mediaKey>.<ext>`
- Updates `MediaRepo.setLocalPath(mediaKey, relativePath)`
- Returns `{ outcome: 'downloaded' | 'skipped' | 'failed', localPath?: string }`
- Skips if file already exists on disk

### Export from `src/temporal/activities/index.ts`

Add `export * from './download.js';`

### Activity types in `src/temporal/shared/activity-types.ts`

```ts
interface MediaDownloadActivities {
  getDownloadableMedia: (input: { limit: number }) => Promise<{ media: Array<{ mediaKey: string; tweetId: string; url: string }> }>;
  getDownloadableMediaCount: () => Promise<number>;
  downloadMedia: (input: DownloadMediaInput) => Promise<DownloadMediaOutput>;
}
```

## CLI Registration

### `src/commands/workflow/start-command/media-download.ts`

New start handler following the enrich pattern:

- Accepts `--limit` and `--batch-size` options (reuses existing CLI options)
- Calls `buildSingleCapabilityPlanOrExit()` with `'download-media'` capability
- Starts workflow via `client.workflow.start(mediaDownloadWorkflow, ...)`

### Wire into handlers

- **`src/commands/workflow/shared.ts`**: Add `'media-download'` to `WorkflowKind` union
- **`src/commands/workflow/start-command/handlers.ts`**: Add to `START_HANDLERS` map
- **`src/commands/workflow/start-command/register.ts`**: Update argument help text
- **`src/commands/workflow/shared.ts`**: Update `WORKFLOW_LIST_QUERY` to include `mediaDownloadWorkflow`

### Capability manifest

- **`src/contracts/manifest.ts`**: Add `'download-media'` capability entry

## SyncWorkflow Integration (Child Workflow)

Mirror the enrich orchestrator pattern:

### `src/temporal/workflows/sync/media-download-orchestrator.ts`

- Same pattern as `enrich-orchestrator.ts`
- `createMediaDownloadOrchestrator()` with `signalMediaDownload()` method
- Child workflow ID: `media-download-after-sync-${parentWorkflowId}`
- `parentClosePolicy: ABANDON` so downloads continue after sync completes

### `src/temporal/workflows/sync/media-download-state.ts`

- `MediaDownloadRuntimeState { started: boolean; workflowId?: string }`

### Modify `src/temporal/workflows/sync/index.ts`

- Create media-download orchestrator alongside enrich orchestrator
- After store phase (same trigger point as enrich), signal media-download workflow
- In finalize: drain-and-exit the media-download child workflow
- In failure path: cancel media-download child workflow
- Add `mediaDownloadWorkflowId` to `SyncWorkflowResult`

### `src/temporal/workflows/sync/finalize.ts`

- Add `finalizeMediaDownloadWorkflowAfterSync()` — same shape as the enrich finalize

## Workflow Export

- **`src/temporal/workflows/index.ts`**: Export `mediaDownloadWorkflow` and its signals/queries
- **`src/temporal/shared/types.ts`**: Export `media-download-types.ts`

## Files to Create

1. `src/temporal/shared/media-download-types.ts`
2. `src/temporal/workflows/media-download/index.ts`
3. `src/temporal/workflows/media-download/signals.ts`
4. `src/temporal/workflows/media-download/runtime.ts`
5. `src/temporal/workflows/media-download/activities.ts`
6. `src/temporal/workflows/media-download/loop.ts`
7. `src/temporal/workflows/media-download/pass.ts`
8. `src/temporal/activities/download.ts`
9. `src/commands/workflow/start-command/media-download.ts`
10. `src/temporal/workflows/sync/media-download-orchestrator.ts`
11. `src/temporal/workflows/sync/media-download-state.ts`

## Files to Modify

1. `src/lib/db/media-repo.ts` — add `ensureLocalPathColumn()`, `getDownloadableMedia()`, `getDownloadableMediaCount()`, `setLocalPath()`
2. `src/lib/config.ts` — add `mediaDir` config field
3. `src/types/config.ts` (or wherever `Config` interface lives) — add `mediaDir: string`
4. `src/types/db.ts` — add `local_path` to `DbMedia`
5. `src/temporal/activities/index.ts` — export download activities
6. `src/temporal/shared/activity-types.ts` — add `MediaDownloadActivities` interface
7. `src/temporal/shared/types.ts` — export media-download types
8. `src/temporal/workflows/index.ts` — export media-download workflow
9. `src/commands/workflow/shared.ts` — add to `WorkflowKind`, `WORKFLOW_LIST_QUERY`
10. `src/commands/workflow/start-command/handlers.ts` — add to `START_HANDLERS`
11. `src/commands/workflow/start-command/register.ts` — update help text
12. `src/contracts/manifest.ts` — add `'download-media'` capability
13. `src/temporal/workflows/sync/index.ts` — integrate media-download orchestrator
14. `src/temporal/workflows/sync/finalize.ts` — add media-download finalize function
15. DB initialization code — call `ensureLocalPathColumn()`

## Verification

1. **Unit tests**: Test `MediaRepo` new methods (getDownloadableMedia, setLocalPath, ensureLocalPathColumn)
2. **Activity tests**: Test download activity with mock HTTP (writes to temp dir)
3. **Typecheck**: `pnpm typecheck`
4. **Lint**: `pnpm lint`
5. **Integration test**: `pnpm dev workflow start media-download --limit 5` against a real database with photo media records
6. **Sync child test**: Run a sync workflow and verify media-download child starts and runs

## Code Review Findings (2026-02-19)

### High

1. ~~**`MEDIA_DIR` is ignored for sync-triggered media downloads**~~ ✅
   - Evidence: `src/temporal/workflows/sync/index.ts:77` hardcodes `mediaDir: './data/media'`, while standalone start uses config (`src/commands/workflow/start-command/media-download.ts:18`).
   - Impact: child media-download workflow writes to a different directory than configured, causing inconsistent behavior between standalone and sync-orchestrated runs.
   - Recommendation: thread `mediaDir` through `SyncWorkflowInput` and pass it from start command config into `createMediaDownloadOrchestrator(...)`.
   - **Resolution**: Added `mediaDir?: string` to `SyncWorkflowInput`. Both sync start paths (`workflow start sync` and `sync bookmarks`) now load config and pass `mediaDir` into the workflow input. The sync workflow uses `input.mediaDir` with `'./data/media'` fallback. Added `MEDIA_DIR` to `.env.example`.

2. ~~**Download activity can throw inside stream error handler and bypass normal failure handling**~~ ✅
   - Evidence: `src/temporal/activities/download.ts:69`-`src/temporal/activities/download.ts:71` calls `fs.unlinkSync(dest)` inside the `fileStream.on('error')` callback without guarding unlink failures.
   - Impact: an `unlinkSync` failure (for example, file not created yet or filesystem error) can throw from the callback path and crash/abort worker execution instead of returning a controlled activity failure.
   - Recommendation: wrap cleanup in `try/catch` (or use forceful async removal) and always resolve via `reject(err)` after cleanup attempt.
   - **Resolution**: Replaced entire `downloadFile()` with Node built-in `fetch()` + `Readable.fromWeb()` + `pipeline()`. The callback-based stream error handler is eliminated — `pipeline()` propagates errors through normal promise rejection. Partial file cleanup remains in the outer `downloadMedia()` catch block with guarded `unlinkSync`.

3. ~~**HTTP client is fragile — no User-Agent, single-hop redirects, no timeouts**~~ ✅
   - Evidence: `src/temporal/activities/download.ts` uses raw `node:http`/`node:https` with `client.get()` — sends no `User-Agent` header, manually handles only one redirect hop, and has no connection/response timeout.
   - Impact: CDN infrastructure (pbs.twimg.com) may reject or deprioritize requests without a proper `User-Agent`. Chained redirects silently fail. Stalled connections hang until Temporal's 2-minute activity timeout kills the worker, wasting a retry attempt.
   - Recommendation: replace with Node built-in `fetch()` which handles redirects automatically, add a `User-Agent` header, and use `AbortController` for download timeouts. Validate response `content-type` before writing.
   - Research notes: X docs ([data dictionary — media](https://docs.x.com/x-api/fundamentals/data-dictionary#media)) confirm media URLs (`pbs.twimg.com`) are public CDN assets — no API auth or token required for access, no documented expiration. The risk is bot-detection from missing headers, not auth. Node built-in `fetch()` (available since Node 18, no new dependencies) is the recommended replacement: automatic redirect chain handling (up to 20 hops), `AbortController` for timeouts, `Response.body` stream pipeable to disk via `Writable.fromWeb()`, and standard `Headers` for `User-Agent`. Alternatives considered: `undici` (powers `fetch()` internally, adds complexity for no gain), `got`/`axios` (unnecessary new dependency for simple CDN GETs), keep `node:http` (all identified problems remain).
   - **Resolution**: Replaced `node:http`/`node:https` with Node built-in `fetch()`. Added `User-Agent: x-bookmarks-scraper/1.0 (media-download)` header. Uses `redirect: 'follow'` for automatic redirect chain handling. `AbortController` with 60s timeout prevents stalled connections. Response `content-type` is validated to reject non-image responses. Stream piping uses `Readable.fromWeb()` + `pipeline()` from `node:stream/promises`.

### Medium

1. ~~**Verification coverage is incomplete for the highest-risk code paths**~~ ✅
   - Evidence: plan verification requested activity and sync-child coverage, but only repository/workflow unit tests were added (`tests/media-repo.test.ts`, `tests/media-download-workflow.test.ts`). No direct tests for `src/temporal/activities/download.ts` network/filesystem behavior and no sync-child orchestration assertions.
   - Additional signal: sync workflow tests do not mock/assert `getDownloadableMediaCount` in the hoisted activity stub (`tests/temporal-sync-workflow.test.ts:4`-`tests/temporal-sync-workflow.test.ts:16`), so media-download trigger/finalize paths are not explicitly validated.
   - Recommendation: add tests for redirect/download/cleanup/error handling in `download.ts`, plus sync tests asserting media child start/trigger/drain/cancel and `mediaDownloadWorkflowId` propagation.
   - **Resolution**: Added `tests/download-activity.test.ts` with 21 tests covering: `extractExtension` (9 URL patterns), `downloadFile` (successful download, User-Agent header, redirect config, non-OK response, non-image content-type, missing content-type, null body), and `downloadMedia` (successful download with DB update, skip-on-exists, failure with cleanup, config fallback, directory creation). Added `getDownloadableMediaCount` to sync workflow test mocks and 7 new tests in `tests/temporal-sync-workflow.test.ts` covering: child start with workflowId in result, skip when no downloadable media, process error on start failure, drain-and-exit signal during finalization, cancel signal on sync failure, trigger signals across pages, and mediaDir passthrough.

### Low

1. ~~**Documentation is not updated for new media-download configuration and usage**~~ ✅
   - Evidence: ~~`.env.example` does not include `MEDIA_DIR` (`.env.example:1`)~~, and README environment/command docs do not mention media-download workflow configuration (`README.md:69`-`README.md:85`).
   - Impact: operational discoverability is reduced and users may not realize they can configure media storage.
   - Recommendation: ~~document `MEDIA_DIR`~~, standalone `workflow start media-download`, and sync-triggered media download behavior.
   - **Resolution**: Added `MEDIA_DIR` to README environment variables table. Added "Media Download" section to README documenting standalone workflow usage (`workflow start media-download`), options (`--limit`, `--batch-size`), file storage layout (`<tweet_id>/<media_key>.<ext>`), and sync-triggered child workflow behavior.
