# Plan: Video Download Workflow

**Status:** Planned
**Created:** 2026-03-04
**Source:** ~/.claude/plans/purring-splashing-pike.md
**Version:** 3.0

## Context

The scraper already stores video/animated_gif media records (with `variants` arrays containing MP4 URLs) and tweet entities containing YouTube URLs in the database — but only photo media is downloaded to disk. This plan adds a new `video-download` Temporal workflow that downloads both native X videos (via `fetch`) and YouTube videos (via `yt-dlp`) to the same `<mediaDir>/<tweetId>/` directory structure.

**Decisions:**

- Single workflow with two sub-passes (native X videos, then YouTube URLs)
- Best MP4 quality format for yt-dlp (`bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`)
- Standalone only — no sync child integration for now
- Control/progress CLI parity matches `media-download` (which also lacks pause/resume/cancel/progress CLI wiring)

---

## Phase 1: Database Layer

### 1a. Extend `MediaRepo` for video queries

**Modify:** `src/lib/db/media-repo.ts`

Add two methods:

- `getDownloadableVideos(limit)` — `WHERE type IN ('video', 'animated_gif') AND local_path IS NULL AND download_error IS NULL AND full_json IS NOT NULL`; returns `{ mediaKey, tweetId, fullJson }`
- `getDownloadableVideoCount()` — count of above

Existing `setLocalPath` and `setDownloadError` already work for any `media_key`.

### 1b. New `YouTubeUrlRepo`

**Create:** `src/lib/db/youtube-url-repo.ts`

New table:

```sql
CREATE TABLE IF NOT EXISTS youtube_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL,
  url TEXT NOT NULL,
  local_path TEXT,
  download_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tweet_id, url),
  FOREIGN KEY (tweet_id) REFERENCES tweets(id)
);
```

Methods: `ensureTable()`, `upsertUrl(tweetId, url)`, `getDownloadableUrls(limit)`, `getDownloadableUrlCount()`, `setLocalPath(tweetId, url, path)`, `setDownloadError(tweetId, url, error)`

### 1c. YouTube extraction scan cursor

The `youtube_urls` table only stores discovered URLs — tweets with zero YouTube links get no row and can't be marked as "scanned."

We need a cursor that does not miss tweets that were inserted as stubs and enriched later. A `rowid` cursor can miss those records because `rowid` is fixed at insert time while `full_json` is populated later.

**Solution:** Use the existing `sync_state` key-value table with a stable `(synced_at, id)` cursor.

- Keys:
  - `youtube_extract_cursor_synced_at`
  - `youtube_extract_cursor_tweet_id`
- Query:
  - `SELECT id, synced_at, full_json FROM tweets`
  - `WHERE full_json IS NOT NULL`
  - `AND (synced_at > ? OR (synced_at = ? AND id > ?))`
  - `ORDER BY synced_at ASC, id ASC`
  - `LIMIT ?`
- After processing a batch, update cursor to the last processed `(synced_at, id)`
- This makes extraction incremental without missing late-enriched tweets

Add to `YouTubeUrlRepo`:

- `getScanCursor(): { syncedAt: string; tweetId: string }` — reads from `sync_state` (returns `{ syncedAt: '', tweetId: '' }` if not set)
- `setScanCursor(cursor: { syncedAt: string; tweetId: string }): void` — writes to `sync_state`
- `getTweetsForScan(cursor: { syncedAt: string; tweetId: string }, limit: number): Array<{ tweetId: string; syncedAt: string; fullJson: string }>`

### 1d. Wire into `BookmarksDb`

**Modify:** `src/lib/db/client.ts`

- Instantiate `YouTubeUrlRepo`, call `ensureTable()` in `init()`
- Add public wrapper methods: `getDownloadableVideos()`, `getDownloadableVideoCount()`, `getDownloadableYouTubeUrls()`, `getDownloadableYouTubeUrlCount()`, `setYouTubeUrlLocalPath()`, `setYouTubeUrlDownloadError()`, `upsertYouTubeUrl()`, `getYouTubeScanCursor()`, `setYouTubeScanCursor()`, `getTweetsForYouTubeScan()`

### 1e. Schema documentation

**Modify:** `src/lib/db/schema.ts` — add `youtube_urls` table DDL

---

## Phase 2: Shared Types

### 2a. Video download types

**Create:** `src/temporal/shared/video-download-types.ts`

```typescript
export interface VideoDownloadWorkflowInput {
  limit?: number;
  batchSize?: number;
  mediaDir?: string;
  includeYouTube?: boolean; // default true
  awaitTriggers?: boolean;
  continueAsNewThreshold?: number;
}

export interface VideoDownloadCarryForward {
  downloaded: number;
  failed: number;
  skipped: number;
  notFound?: number;
  pendingTriggers: number;
  drainAndExitRequested: boolean;
  startTimeMs: number;
}

export interface VideoDownloadWorkflowResult {
  downloaded: number;
  failed: number;
  skipped: number;
  notFound: number;
  remaining: number;
  durationMs: number;
}

export interface VideoDownloadProgress {
  downloaded: number;
  failed: number;
  skipped: number;
  notFound: number;
  remaining: number;
  currentItem?: string;
  lastError?: string;
}
```

### 2b. Activity types

**Modify:** `src/temporal/shared/activity-types.ts`

Add:

```typescript
export interface DownloadNativeVideoInput {
  mediaKey: string;
  tweetId: string;
  fullJson: string;
  mediaDir: string;
}

export interface DownloadYouTubeVideoInput {
  tweetId: string;
  url: string;
  mediaDir: string;
}

export interface DownloadVideoOutput {
  outcome: 'downloaded' | 'skipped' | 'not_found' | 'failed';
  localPath?: string;
}

export interface VideoDownloadActivities {
  getDownloadableVideos: (input: { limit: number }) => Promise<{
    videos: Array<{ mediaKey: string; tweetId: string; fullJson: string }>;
  }>;
  getDownloadableVideoCount: () => Promise<number>;
  downloadNativeVideo: (input: DownloadNativeVideoInput) => Promise<DownloadVideoOutput>;
  getDownloadableYouTubeUrls: (input: { limit: number }) => Promise<{
    urls: Array<{ tweetId: string; url: string }>;
  }>;
  getDownloadableYouTubeUrlCount: () => Promise<number>;
  downloadYouTubeVideo: (input: DownloadYouTubeVideoInput) => Promise<DownloadVideoOutput>;
  extractYouTubeUrls: (input: { batchSize: number }) => Promise<{ extracted: number }>;
}
```

### 2c. Barrel export

**Modify:** `src/temporal/shared/types.ts` — add `export * from './video-download-types.js'`

---

## Phase 3: Activities

### 3a. Native video download

**Create:** `src/temporal/activities/video-download.ts`

Key function: `selectBestVideoVariant(fullJson)` — parses `variants` array, filters to `content_type === 'video/mp4'`, picks highest `bit_rate`.

Activity `downloadNativeVideo`:

- Extract best MP4 URL from `fullJson` via `selectBestVideoVariant()`
- If no variant → `setDownloadError`, return `not_found`
- Download via `fetch` + stream (reuse pattern from `downloadFile` in `download.ts`) but with:
  - `video/mp4` content-type validation
  - 5-minute timeout (vs 60s for photos)
- Save to `<mediaDir>/<tweetId>/<mediaKey>.mp4`
- Call `db.setMediaLocalPath(mediaKey, relativePath)`
- Error classification: same pattern as `download.ts` — 4xx permanent, 5xx/network transient

Activities `getDownloadableVideos`, `getDownloadableVideoCount` — delegate to DB.

### 3b. YouTube URL extraction

**Create:** `src/temporal/activities/youtube-extract.ts`

Activity `extractYouTubeUrls({ batchSize })`:

1. Read scan cursor via `db.getYouTubeScanCursor()`
2. Query tweets after cursor: `db.getTweetsForYouTubeScan(cursor, batchSize)`
3. For each tweet, parse `full_json`, extract `entities.urls[].expanded_url`, filter with `isYouTubeUrl()`
4. Upsert matches into `youtube_urls` table
5. Update cursor to last processed `(synced_at, id)`
6. Return `{ extracted: number }`

Helper: `isYouTubeUrl(url)` — parse hostname, match against `['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube.com', 'm.youtube.com']`

### 3c. YouTube video download (yt-dlp)

**Create:** `src/temporal/activities/youtube-download.ts`

Custom errors:

```typescript
export class YtDlpNotInstalledError extends Error { ... }
export class YtDlpDownloadError extends Error {
  constructor(public readonly exitCode: number | null, public readonly stderr: string, url: string) { ... }
}
```

Activity `downloadYouTubeVideo`:

- Extract video ID from URL for filename (fallback to hash if unparseable)
- Output path: `<mediaDir>/<tweetId>/yt-<videoId>.%(ext)s`
- Spawn: `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o <template> --no-playlist <url>`
- 10-minute timeout via `execFile`
- On success: glob for output file (yt-dlp determines final extension), record `local_path` in `youtube_urls`
- **Error handling:**
  - **ENOENT** (yt-dlp not installed): throw `ApplicationFailure.nonRetryable('yt-dlp not installed', 'YtDlpNotInstalledError')` from `@temporalio/activity`
  - **Permanent yt-dlp errors** (video unavailable/private/removed/age-restricted): Set `download_error` in DB, return `not_found`
  - **Transient errors** (network, rate limit): Return `failed` for Temporal retry

Permanent error detection patterns:

```typescript
const PERMANENT_PATTERNS = [
  'Video unavailable', 'Private video', 'This video has been removed',
  'Sign in to confirm your age', 'is not a valid URL', 'Unsupported URL',
  'This video is no longer available', 'account associated with this video has been terminated',
];
```

Activities `getDownloadableYouTubeUrls`, `getDownloadableYouTubeUrlCount` — delegate to DB.

### 3d. Export

**Modify:** `src/temporal/activities/index.ts` — export new activity modules

---

## Phase 4: Workflow

### 4a. Workflow files

**Create directory:** `src/temporal/workflows/video-download/` (6 files mirroring `media-download/`):

**`signals.ts`** — namespaced to avoid collision with media-download:

```typescript
export const pauseSignal = wf.defineSignal('video-download:pause');
export const resumeSignal = wf.defineSignal('video-download:resume');
export const cancelSignal = wf.defineSignal('video-download:cancel');
export const triggerSignal = wf.defineSignal('video-download:trigger');
export const drainAndExitSignal = wf.defineSignal('video-download:drainAndExit');
export const progressQuery = wf.defineQuery<VideoDownloadProgress>('video-download:progress');
```

**`activities.ts`** — proxy with video-appropriate timeouts:

```typescript
export const videoDownloadActivities = wf.proxyActivities<typeof import('../../activities/index.js')>({
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 2,
  },
});
```

**`runtime.ts`** — state object + signal handlers (same shape as `media-download/runtime.ts`, using `VideoDownloadProgress`). Field `currentItem` instead of `currentMediaKey` to handle both media keys and YouTube URLs.

**`pass.ts`** — two sub-passes in sequence:

1. **Native videos**: fetch batch via `getDownloadableVideos` → `downloadNativeVideo` each
2. **YouTube URLs** (if `includeYouTube`): run `extractYouTubeUrls` once → fetch batch via `getDownloadableYouTubeUrls` → `downloadYouTubeVideo` each

Combined remaining count = native + YouTube counts.

**`loop.ts`** — reuse same trigger-based loop pattern from `media-download/loop.ts`. Uses a combined count function that sums `getDownloadableVideoCount()` + `getDownloadableYouTubeUrlCount()` (when `includeYouTube`).

**`index.ts`** — main workflow entry with continueAsNew support. Same structure as `media-download/index.ts`.

### 4b. Barrel + index

**Create:** `src/temporal/workflows/video-download.ts` — barrel export
**Modify:** `src/temporal/workflows/index.ts` — add video-download exports (with aliased signal names like `videoDownloadPauseSignal` etc.)

---

## Phase 5: CLI Commands

### 5a. StartOptions update

**Modify:** `src/commands/workflow/start-command/types.ts`

Add `youtube?: boolean` to `StartOptions` (commander maps `--no-youtube` to `youtube: false`).

### 5b. Shared helpers

**Create:** `src/commands/shared/video-download.ts`

`prepareVideoDownloadWorkflow()` and `printVideoDownloadDetails()`, mirroring `src/commands/shared/media-download.ts`. Uses `mediaDir` from config.

### 5c. `workflow start video-download`

**Create:** `src/commands/workflow/start-command/video-download.ts`

Same pattern as `media-download.ts`. Reads `options.youtube` (default true) to set `includeYouTube`.

### 5d. `sync video-download`

**Create:** `src/commands/sync/video-download.ts`

Standalone subcommand (not a sync child). Options: `--limit`, `--batch-size`, `--no-youtube`.

### 5e. Wire CLI

**Modify:**

- `src/commands/workflow/shared.ts` — add `'video-download'` to `WorkflowKind` union and `WORKFLOW_LIST_QUERY`
- `src/commands/workflow/start-command/handlers.ts` — import and add `'video-download': startVideoDownloadWorkflow` to `START_HANDLERS`, update error message
- `src/commands/workflow/start-command/register.ts` — add `video-download` to argument description and `--no-youtube` option
- `src/commands/sync/register.ts` — register `sync video-download` subcommand

**Note on control/progress CLI:** The existing `media-download` workflow also lacks wiring in `control.ts` and `status-command/progress.ts` — both files only handle sync/enrich/topicMonitor/engagementTracking. We'll match that scope; control/progress CLI can be added later for both workflows together.

---

## Phase 6: Manifest

**Modify:** `src/contracts/manifest.ts`

Add `'download-video'` to `XDatasourceCapabilityId` type and capability list.

---

## Phase 7: Tests

### 7a. Variant selection + native download activity

**Create:** `tests/video-download-activity.test.ts`

- `selectBestVideoVariant`: highest bitrate MP4, ignores m3u8, null when no MP4s, empty variants, animated_gif single variant
- `downloadNativeVideo`: downloads MP4 + updates local_path, skips existing, not_found on no variants, HTTP 4xx/5xx classification

### 7b. YouTube URL detection + extraction

**Create:** `tests/youtube-extract.test.ts`

- `isYouTubeUrl`: detects all YouTube domains, rejects non-YouTube, handles malformed URLs
- `extractYouTubeUrls` activity: extracts from entities, incremental cursor advances, handles tweets with no YouTube URLs, deduplicates

### 7c. yt-dlp integration

**Create:** `tests/youtube-download-activity.test.ts`

- Mock `execFile`: correct yt-dlp arguments, successful download, permanent error classification, ENOENT handling (non-retryable), timeout handling

### 7d. Workflow

**Create:** `tests/video-download-workflow.test.ts`

- Native video pass: downloads successfully, handles empty batch
- YouTube pass: extraction → download flow, skipped when `includeYouTube: false`
- Mixed pass: aggregates counters from both sub-passes
- Limit enforcement across both sub-passes
- Signal handlers: pause, resume, cancel, trigger, drainAndExit
- ContinueAsNew carry-forward

### 7e. DB layer

**Modify:** `tests/media-repo.test.ts` — add tests for `getDownloadableVideos` and `getDownloadableVideoCount`

---

## Files Summary

**New files (19):**

1. `src/lib/db/youtube-url-repo.ts`
2. `src/temporal/shared/video-download-types.ts`
3. `src/temporal/activities/video-download.ts`
4. `src/temporal/activities/youtube-download.ts`
5. `src/temporal/activities/youtube-extract.ts`
6. `src/temporal/workflows/video-download/index.ts`
7. `src/temporal/workflows/video-download/activities.ts`
8. `src/temporal/workflows/video-download/loop.ts`
9. `src/temporal/workflows/video-download/pass.ts`
10. `src/temporal/workflows/video-download/runtime.ts`
11. `src/temporal/workflows/video-download/signals.ts`
12. `src/temporal/workflows/video-download.ts`
13. `src/commands/shared/video-download.ts`
14. `src/commands/workflow/start-command/video-download.ts`
15. `src/commands/sync/video-download.ts`
16. `tests/video-download-activity.test.ts`
17. `tests/youtube-extract.test.ts`
18. `tests/youtube-download-activity.test.ts`
19. `tests/video-download-workflow.test.ts`

**Modified files (14):**

1. `src/lib/db/media-repo.ts` — `getDownloadableVideos`, `getDownloadableVideoCount`
2. `src/lib/db/client.ts` — `YouTubeUrlRepo` + wrapper methods
3. `src/lib/db/schema.ts` — `youtube_urls` DDL
4. `src/temporal/shared/activity-types.ts` — video activity types
5. `src/temporal/shared/types.ts` — barrel export
6. `src/temporal/activities/index.ts` — export new activities
7. `src/temporal/workflows/index.ts` — export video-download workflow
8. `src/commands/workflow/shared.ts` — `WorkflowKind`, `WORKFLOW_LIST_QUERY`
9. `src/commands/workflow/start-command/types.ts` — `youtube` on `StartOptions`
10. `src/commands/workflow/start-command/handlers.ts` — handler + error message
11. `src/commands/workflow/start-command/register.ts` — help text + `--no-youtube` option
12. `src/commands/sync/register.ts` — register subcommand
13. `src/contracts/manifest.ts` — capability
14. `tests/media-repo.test.ts` — video query tests

---

## Verification

1. **yt-dlp prerequisite:** `yt-dlp --version` — must be installed
2. **Native X video download:** `pnpm dev workflow start video-download --limit 2` — verify `.mp4` files appear in `<mediaDir>/<tweetId>/`
3. **YouTube download:** Ensure a bookmarked tweet contains a YouTube link, then run `pnpm dev workflow start video-download --limit 1` — verify yt-dlp output appears in `<mediaDir>/<tweetId>/yt-<videoId>.mp4`
4. **Skip YouTube:** `pnpm dev workflow start video-download --no-youtube --limit 2` — only native videos downloaded
5. **Incremental extraction:** Run extraction twice — second run should not rescan already-scanned tweets
6. **yt-dlp not installed:** Unset PATH or rename binary, run workflow — should fail immediately with non-retryable error (no retry churn)
7. **Lint/type-check:** `pnpm check` passes
8. **Tests:** `pnpm test` passes

## Notes
