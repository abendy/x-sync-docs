# Enable local stub enrichment in `sync enrich`

## Context

The recent refactor (97f77e3) decoupled enrichment from the sync engine. For the Temporal path, the SyncWorkflow auto-spawns a child EnrichWorkflow for stubs. But for the local path (`--local`), the `sync enrich` subcommand **only supports `--outdated` mode** — it errors out if `--outdated` isn't passed. There's no local path for enriching stub records (`full_json IS NULL`).

When a user runs `pnpm dev sync <id> --local`, the CLI prints "run enrichment separately" but the suggested local command (`sync enrich --outdated`) doesn't actually process stubs.

## Changes

**File: `src/commands/sync.ts` (lines 355-478)**

Make stub enrichment the default mode for `sync enrich`, with `--outdated` as an opt-in variant:

1. **Remove the `--outdated` requirement gate** (lines 375-379) — no longer error when `--outdated` is absent
2. **Add stub-mode logic**: When `--outdated` is not passed, query stubs via `db.getTweetsNeedingEnrichment(batchSize)` (same query the Temporal workflow uses via `getStubRecords`)
3. **Use `db.getTweetCompletenessStats().stubs`** for the initial count and final remaining count (mirroring the Temporal workflow's `getStubCount`)
4. **Adjust header/labels**: Show "Mode: ENRICH STUBS" vs "Mode: RE-ENRICH OUTDATED"
5. **Pass `force: false`** to `enrichRecordActivity` for stub mode (vs `force: true` for outdated mode)
6. **Update the post-sync hint** (line 339) to show `pnpm dev sync enrich` (without `--outdated`)

The enrichment loop (lines 416-470) is already well-structured with batch processing, rate limit handling, and progress display — it just needs to be parameterized by mode.

### Existing building blocks (no new code needed)

- `db.getTweetsNeedingEnrichment(limit)` — `src/lib/db.ts:548`
- `db.getTweetCompletenessStats().stubs` — `src/lib/db.ts:561`
- `enrichRecordActivity({ tweetId, force })` — already imported at `src/commands/sync.ts:20`

## Verification

1. Build: `pnpm build`
2. Run sync that produces stubs: `pnpm dev sync <folder-id> --local --no-delete`
3. Run local enrichment: `pnpm dev sync enrich` (should process stubs)
4. Confirm `--outdated` still works: `pnpm dev sync enrich --outdated`
5. `pnpm test && pnpm lint && pnpm typecheck`
