# Code Review: Structure, Cleanliness, Expandability

Repository: x-bookmarks-scraper
Date: 2026-01-15
Status: Complete. All actionable items implemented (assessed 2026-02-13).

## Overall Assessment

Strong foundation: clear modular layout, strict TypeScript, pragmatic DB schema, and Temporal workflows for durability. DataSource abstraction and completeness strategy are good enablers for future sources and enrichment. Biggest gaps: real enrichment path not implemented, rate-limit handling is mostly time-based, and sync logic is duplicated between CLI and workflows.

## Strengths

- Structure: `src/commands`, `src/lib`, `src/sources`, `src/temporal` map cleanly; activities vs workflows separation is solid.
- Data model: nullable fields with `full_json` and COALESCE updates; `verifyBookmarkForDelete()` protects against deleting stubs.
- Durability: Temporal signals/queries and sleeps model long waits well.
- Tooling: Biome + Oxlint + Vitest + Husky with sensible defaults.

## Critical Action Items

- Implement enrichment
  - Add `XApiDataSource.fetchTweetDetails()` (GET `/2/tweets/:id` with expansions); gate by tier/capabilities.
  - In `enrichWorkflow`, select a source via `registry.getBestEnrichmentSource()`; skip gracefully if none.
- Rate limit adaptation
  - Return headers from `lib/api` methods and call `rateLimiter.updateFromHeaders()` after each request.
  - Prefer header-based waits (`x-rate-limit-reset/remaining`), fallback to `SYNC_INTERVAL_MS` and durable sleep on 429s.
- Remove duplication
  - Extract a shared `SyncEngine` (backlog → fetch page → store → delete) used by both CLI and Temporal.
- Testing
  - Add unit tests for `RateLimiter`, API mapping (full vs ids_only), DB verification, and activities.

## Suggestions (Current State)

- Use the `sources/registry` in commands and activities to pick sources by capability (prep for paid tier or alternates).
- Persist pagination/resume tokens in `sync_state`; add `--resume` to CLI.
- Normalize output: use `notifications` for console, `logger` for JSONL; avoid mixing.
- Add a durable delete queue and retry/backoff for failures.

## Architecture Extensions (Toward Goals)

- Conversation graph: add `tweet_edges(tweet_id, related_id, type)` from `referenced_tweets` and `conversation_id`.
- Search/monitoring: FTS5 on `tweets.text`; tables for `watch_users`, `watch_terms` to drive scheduled ingestion.
- Alternative sources: paid X API source with `canFetchTweetDetails=true`; optional scraping/third‑party behind explicit risk profiles.
- Enrichment variants: batch conversation enrichment to gather replies/quotes around seeds.

## Iteration Roadmap

1) Header-aware limiter wiring in `lib/api` → `RateLimiter`.
2) Implement `fetchTweetDetails()` and enable real enrichment.
3) Introduce `SyncEngine` and make CLI start workflows by default (or share core).
4) Resume support via `sync_state`.
5) Add FTS5 and `tweet_edges`; populate on store/enrich.
6) Registry-based source selection with paid-tier toggle.
7) Expand tests and minimal metrics (counts, durations).

## Actionable Checklist & Status

- [x] P0 Implement `XApiDataSource.fetchTweetDetails()` (GET `/2/tweets/:id` with fields/expansions), gate by tier/capabilities.
  - Acceptance: Enrich workflow upgrades at least one stub end-to-end; capabilities updated to `canFetchTweetDetails=true` when enabled.
- [x] P0 Header-aware rate limiting in `lib/api` and `RateLimiter`.
  - Acceptance: Headers (`x-rate-limit-remaining/reset`) propagate and adjust sleeps; 429 path sets precise `retryAfterMs`.
- [x] P0 Extract shared `SyncEngine` used by CLI and Temporal.
  - Acceptance: CLI sync path delegates to engine; Temporal activities call the same engine functions for fetch/store/delete; no feature drift.
- [x] P1 Persist pagination/resume state in `sync_state`; add `--resume` flag.
  - Acceptance: Interrupted sync can resume without refetching already-processed pages; manual `clear` command resets state.
- [x] P1 Tests: `RateLimiter`, API mapping (full vs ids_only), `verifyBookmarkForDelete()`, store/delete activities.
  - Acceptance: Vitest suite added; CI threshold ≥ 70% for touched areas.
- [x] P1 Use `sources/registry` selection in commands/activities.
  - Acceptance: Source chosen by capability; paid-tier source plugged in via config switch.
- [x] P2 Add `tweet_edges` table and FTS5 for `tweets.text` (optional content).
  - Acceptance: Migration in place; edges recorded from `referenced_tweets`/`conversation_id`; basic edge queries work.
- [x] P2 Durable delete queue with retry/backoff.
  - Acceptance: Failed deletes persisted and retried with exponential backoff across runs.
- [x] P2 Output normalization: `notifications` for console, `logger` for JSONL.
  - Acceptance: Console output consistent; file logs remain structured.

## Suggested PR Sequence

1) Rate-limit wiring (headers → limiter) + tests.
2) `fetchTweetDetails` + enrich workflow activation (behind tier flag).
3) `SyncEngine` refactor; CLI and Temporal use the same core.
4) Resume support via `sync_state` (+ commands to inspect/clear state).
5) Edge graph + optional FTS5 migration and storage hooks.
6) Registry-driven source selection and paid-tier source toggle.
7) Durable delete queue/backoff + observability polish.
