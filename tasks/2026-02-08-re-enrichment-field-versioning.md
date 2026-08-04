# Re-enrichment workflow with field versioning

**Status:** Complete

## Context

We expanded the X API fields/expansions requested during enrichment (added `note_tweet`, `display_text_range`, `article`, `verified_type`, `profile_banner_url`, new expansions, etc.). All existing enriched records (`full_json IS NOT NULL`) were fetched with the old field set and are now outdated. Field sets will continue evolving as profile scans, stream ingestion, and topic tracking are built out. We need a mechanism to version field configs, identify outdated records, and re-enrich them.

## Design decisions

1. **Extend `enrichWorkflow` with `--outdated` flag** — not a separate workflow. The orchestration (batching, rate limits, pause/resume/cancel, progress) is identical. Only the discovery query and the "skip already enriched" guard change.

2. **`FIELDS_VERSION` lives in `src/lib/api.ts`** alongside the field arrays it describes. Simple monotonically increasing integer, bumped when any field/expansion changes.

3. **Only version tweets** — users and media are re-fetched as side effects of tweet enrichment. No need for separate version columns on those tables.

4. **Pass version into workflow as input** (not imported in workflow code) for Temporal determinism. The CLI sets `currentFieldsVersion` from `FIELDS_VERSION` at invocation time so it's captured at workflow start.

5. **Code constant is source of truth** — no DB table for field config definitions. A changelog comment in `api.ts` documents what each version includes.

6. **NULL `fields_version` = pre-versioning (version 0)** — no backfill needed.

## Implementation

### 1. Add `FIELDS_VERSION` constant

**File:** `src/lib/api.ts` (after EXPANSIONS array, ~line 115)

```ts
/**
 * Field set version — bump when TWEET_FIELDS, USER_FIELDS, MEDIA_FIELDS,
 * PLACE_FIELDS, POLL_FIELDS, or EXPANSIONS change.
 *
 * Changelog:
 *   1 — added note_tweet, display_text_range, article, verified_type,
 *       profile_banner_url, affiliation, parody, article.media_entities,
 *       attachments.media_source_tweet, entities.note.mentions.username,
 *       referenced_tweets.id.attachments.media_keys
 */
export const FIELDS_VERSION = 1;
```

### 2. Add `fields_version` column to tweets table

**File:** `src/lib/db.ts`

- Add migration method `ensureFieldsVersionColumn()` following the existing `ensureUnavailableAtColumn()` pattern (PRAGMA table_info introspection)
- Call from `init()` after `ensureUnavailableAtColumn()`
- Add index: `CREATE INDEX IF NOT EXISTS idx_tweets_fields_version ON tweets(fields_version)`

**File:** `src/types/index.ts`

- Add `fields_version: number | null` to `DbTweet` interface

### 3. Write `fields_version` on upsert

**File:** `src/lib/db.ts` — `upsertTweet()`

- Add optional second param: `upsertTweet(tweet: TweetObject, fieldsVersion?: number)`
- Add `fields_version` to INSERT columns and ON CONFLICT UPDATE clause
- Pass `fieldsVersion ?? null` as bind value

### 4. Pass `FIELDS_VERSION` through all upsert callers

| Caller | File | Change |
| --- | --- | --- |
| `storeBookmarks` activity | `src/temporal/activities/store.ts:46` | `db.upsertTweet(tweet._fullJson, FIELDS_VERSION)` |
| `storeBookmarks` activity (included tweets) | `src/temporal/activities/store.ts:95` | `db.upsertTweet(included, FIELDS_VERSION)` |
| `enrichRecord` activity | `src/temporal/activities/store.ts:171` | `db.upsertTweet(details.tweet, FIELDS_VERSION)` |
| `enrichRecord` activity (included tweets) | `src/temporal/activities/store.ts:190` | `db.upsertTweet(included, FIELDS_VERSION)` |
| `CliSyncOperations.storeBookmarks` | `src/commands/sync-adapter.ts:106` | `this.db.upsertTweet(tweet._fullJson, FIELDS_VERSION)` |
| `CliSyncOperations.storeBookmarks` (included) | `src/commands/sync-adapter.ts:156` | `this.db.upsertTweet(included, FIELDS_VERSION)` |
| `CliSyncOperations.enrichRecord` | `src/commands/sync-adapter.ts:192` | `this.db.upsertTweet(details.tweet, FIELDS_VERSION)` |
| `CliSyncOperations.enrichRecord` (included) | `src/commands/sync-adapter.ts:204` | `this.db.upsertTweet(included, FIELDS_VERSION)` |

### 5. Add outdated query methods to DB

**File:** `src/lib/db.ts`

```ts
getOutdatedTweets(currentVersion: number, limit = 100): DbTweet[]
// WHERE full_json IS NOT NULL
//   AND (fields_version IS NULL OR fields_version < ?)
//   AND unavailable_at IS NULL
// ORDER BY synced_at DESC LIMIT ?

getOutdatedCount(currentVersion: number): number
// Same WHERE clause, COUNT(*)
```

### 6. Add query activities for outdated records

**File:** `src/temporal/shared/types.ts`

- Add `GetOutdatedRecordsInput { currentVersion: number; limit: number }`
- Add `GetOutdatedRecordsOutput { tweets: Array<{ id: string; authorId: string | null }> }`

**File:** `src/temporal/activities/query.ts`

- Add `getOutdatedRecords(input)` and `getOutdatedCount(input)` activities

### 7. Add `force` flag to `enrichRecord` activity

**File:** `src/temporal/shared/types.ts`

- Add `force?: boolean` to `EnrichRecordInput`

**File:** `src/temporal/activities/store.ts` — `enrichRecord()`

- Change guard at line 128: `if (!wasStub && !input.force)` — skip only when not forced

### 8. Extend workflow input and logic

**File:** `src/temporal/shared/types.ts`

- Add `outdated?: boolean` and `currentFieldsVersion?: number` to `EnrichWorkflowInput`

**File:** `src/temporal/workflows/enrich.ts`

- Proxy new activities (`getOutdatedRecords`, `getOutdatedCount`)
- Determine mode: `const mode = input.outdated ? 'outdated' : input.retryUnavailable ? 'unavailable' : 'stub'`
- Route initial count query by mode
- Route batch fetch query by mode (pass `input.currentFieldsVersion!` to outdated queries)
- Pass `force: mode === 'outdated'` to `enrichRecord` calls

### 9. Add `--outdated` CLI flag

**File:** `src/commands/workflow.ts`

- Add `.option('--outdated', 'Re-enrich records fetched with older API field set')`
- Add to options type
- Populate `EnrichWorkflowInput.outdated` and `currentFieldsVersion` from `FIELDS_VERSION`
- Validate `--outdated` and `--retry-unavailable` are mutually exclusive
- Display `Mode: RE-ENRICH OUTDATED` in output

### 10. Update status display

**File:** `src/commands/status.ts`

- Import `FIELDS_VERSION` from `api.ts`
- After showing stubs/unavailable, show outdated count if > 0:
  `Outdated: N (run \`workflow start enrich --outdated\` to refresh)`

### 11. Local re-enrichment path

**File:** `src/commands/sync-adapter.ts`

- Pass `FIELDS_VERSION` to all `upsertTweet` calls (covered in step 4)
- For the local `--outdated` command: add a standalone loop in `src/commands/sync.ts` (or a new `enrich` subcommand) that iterates `db.getOutdatedTweets()` and calls the enrichment source directly — avoids changing the `SyncOperations` interface

## Files modified

| File | Changes |
| --- | --- |
| `src/lib/api.ts` | Add `FIELDS_VERSION` constant with changelog |
| `src/lib/db.ts` | Migration, `fields_version` in upsertTweet, `getOutdatedTweets()`, `getOutdatedCount()` |
| `src/types/index.ts` | `fields_version` on `DbTweet` |
| `src/temporal/shared/types.ts` | `force?` on `EnrichRecordInput`, `outdated?`/`currentFieldsVersion?` on `EnrichWorkflowInput`, outdated I/O types |
| `src/temporal/activities/store.ts` | `force` guard, pass `FIELDS_VERSION` to upserts |
| `src/temporal/activities/query.ts` | `getOutdatedRecords()`, `getOutdatedCount()` |
| `src/temporal/workflows/enrich.ts` | Proxy new activities, outdated mode routing |
| `src/commands/workflow.ts` | `--outdated` flag, validation, display |
| `src/commands/sync-adapter.ts` | Pass `FIELDS_VERSION` to upserts |
| `src/commands/status.ts` | Show outdated count |

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm lint` — biome + oxlint clean
3. `pnpm test` — all existing tests pass
4. New DB tests: `getOutdatedTweets` returns NULL/old version records, excludes current version and unavailable
5. New activity tests: `enrichRecord` with `force: true` re-fetches even when `full_json` is populated
6. New workflow tests: outdated mode calls correct query activities and passes `force: true`
7. Manual: `pnpm dev status` shows outdated count
8. Manual: `pnpm dev workflow start enrich --outdated --limit 5` processes outdated records

## Commits

1. `feat(db): add fields_version column and outdated query methods`
2. `feat(api): add FIELDS_VERSION constant for field set tracking`
3. `feat(enrich): stamp fields_version on upsert and support force re-enrichment`
4. `feat(enrich): add outdated mode to enrich workflow`
5. `feat(cli): add --outdated flag and show outdated count in status`
6. `test(enrich): cover re-enrichment of outdated records`
