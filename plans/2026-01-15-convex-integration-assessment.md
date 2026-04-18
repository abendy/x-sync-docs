# Convex Integration Assessment (with Temporal)

Date: 2026-01-15
Repository: x-bookmarks-scraper

## Summary

Convex can complement Temporal as the real-time control plane, multi-user backend, and configuration store while Temporal remains the long-running orchestration engine. Use Convex for reactive data (progress dashboards, watchlists, alerts), global coordination (rate-limit leasing across workers/devices), and cloud search/monitoring, without moving the core SQLite truth for content. This positions the project for future features: conversation context (replies/quotes), app-wide search, and monitoring key contributors.

## Roles and Responsibilities

- Temporal
  - Durable workflows (sync, enrich), retries, pause/resume/cancel.
  - Heavy, rate-limited operations and long sleeps.
- Convex
  - Real-time state and UI subscriptions (progress, statuses, alerts).
  - Multi-user auth, configuration, and secrets (per-user settings, watchlists).
  - Global rate-limit coordination (token bucket/lease across processes).
  - Search and indexing for cloud queries; lightweight shadow of local data.

## Proposed Convex Data Model (minimal viable)

- users: auth identity, profile, roles.
- accounts: external tokens metadata (X userId, tier, obfuscated token refs; avoid storing raw tokens unless encrypted).
- workflows: { id, type: 'sync'|'enrich', status, startedAt, updatedAt, nextRateLimitReset, stats: {fetched, stored, deleted, errors}, ownerUserId }.
- workflow_events: append-only progress/events for timelines.
- bookmarks_shadow: minimal mirror { tweetId, folderId?, deletedFromX, syncedAt, completeness: 'stub'|'partial'|'full' }.
- tweets_shadow: { tweetId, authorId?, createdAt?, hasMedia, completeness } (no tweet text by default for privacy; optional opt-in).
- tweet_edges: { tweetId, relatedId, type: 'quoted'|'replied_to'|'retweeted' } for conversation graphs.
- monitors: watchlists (users, terms), schedules, lastRun.

## Function Surface (Convex)

- Mutations
  - workflows.create/start/finish/updateProgress
  - rateLimits.leaseNextCall({ tokenKey, windowMs, limit }) → { allowAtMs, remaining }
  - bookmarks.upsertShadow(batch)
  - graphs.recordEdges(batch)
  - monitors.upsert({ users, terms, cadence })
- Queries
  - workflows.byUser / byId (live)
  - dashboards.overview (completeness, recent errors, running workflows)
  - bookmarks.search({ q, filters })
  - monitors.list()
- Actions (external I/O from Convex)
  - webhooks.notify({ event })
  - optional: downstream integrations (email, Slack)
- Crons
  - monitors.poll() -> enqueue enrich/sync intents
  - housekeeping: expire old leases, compact events

## Temporal ↔ Convex Integration Points

- Activity hooks
  - publishProgressToConvex(progress) on fetch/store/delete loops.
  - leaseRateLimit() before API calls to coordinate across machines.
  - recordShadowsAndEdges() after storing to DB (ids only) to power cloud dashboards.
- CLI mode (optional flag `--cloud`)
  - Initialize a Convex client and attach workflowId so local runs also publish progress.

## Rate Limit Coordination Design

- Store per-token counters: { key: `${xUserId}:${scope}`, remaining, resetAt }.
- leaseNextCall():
  - If now < resetAt and remaining > 0 → decrement and return { allowAtMs: now }.
  - If remaining == 0 → return { allowAtMs: resetAt }.
  - On new window (now ≥ resetAt) → reset { remaining = limit, resetAt = now + windowMs }.
- Temporal/CLI respects allowAtMs by sleeping until allowed (Temporal: durable sleep; CLI: local countdown). On actual 429s, update window based on headers and write back to Convex.

## Data Flow (MVP)

1) User kicks off sync (CLI or Temporal): workflow row created in Convex.
2) Before each API call: leaseRateLimit() from Convex; if delayed, show countdown.
3) After storing in SQLite: publish minimal shadows and edges to Convex.
4) UI subscribes to workflows.byId to show live progress, completeness, next reset.

## Search & Context Roadmap

- Short term: Convex queries on shadows + edges for cloud browsing and stats.
- Full text: keep SQLite FTS locally; optionally opt-in to push normalized text to Convex and build a search index (or integrate an external vector/search service; keep embeddings metadata in Convex).
- Conversation view: use tweet_edges to render quotes/replies graph around a seed tweet; enrichment workflow can prioritize neighbors.

## Security & Privacy

- Default: store IDs and metadata only in Convex (no tweet text). Make content syncing opt-in per user.
- Secrets: do not store raw X tokens in Convex unless encrypted and necessary; prefer device-local tokens. If stored, encrypt with KMS and scope per user.
- Multi-tenant isolation via userId partitioning and RLS-like checks in Convex functions.

## Developer Experience

- New folder `convex/` with schema, functions, crons.
- Env: `CONVEX_URL`, `CONVEX_DEPLOYMENT`, `CONVEX_ADMIN_KEY` (server-only in workers).
- Scripts: `pnpm convex:dev`, `pnpm convex:deploy`.
- Lightweight Node client in workers/CLI to call mutations/queries (or an HTTPS endpoint for Actions).

## Phased Implementation Plan

- Phase 0 (scaffolding)
  - Add Convex project, basic auth wiring, empty schema, health check.
- Phase 1 (observability)
  - workflows + events tables; publishProgressToConvex() from CLI and Temporal.
- Phase 2 (coordination)
  - rateLimits.leaseNextCall() and usage in API calls; reconcile with header-based resets.
- Phase 3 (shadow index)
  - bookmarks_shadow, tweets_shadow, tweet_edges; batch upserts from store activity.
- Phase 4 (watch/alerts)
  - monitors + crons; schedule enrich/sync intents; simple alerts.
- Phase 5 (search & context)
  - Optional content sync + search index; conversation UI using edges.

## Open Questions / Risks

- Token custody: do we centralize tokens for headless workers or keep them local only?
- Search cost vs privacy: do we sync text to cloud? Consider opt-in and redaction.
- Rate-limit accuracy: X headers can be coarse; keep local fallback and reconcile windows carefully.
- Dual truth: SQLite remains source of tweet content; Convex is derived. Establish clear reconciliation rules and backfill jobs.

## Immediate Next Steps

1) Create Convex app and add `convex/` with minimal schema: users, workflows, events, rateLimits.
2) Add a small worker-side client and an activity `publishProgressToConvex()`; start pushing progress from workflows.
3) Implement `rateLimits.leaseNextCall()` and call it in `lib/api` before requests; on 429, write updated reset.
4) Add `bookmarks_shadow` upsert from store activity (ids only). Build a simple dashboard page consuming `workflows.byId`.
