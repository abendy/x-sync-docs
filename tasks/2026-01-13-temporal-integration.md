# Technical Plan: Temporal Default Integration (Updated)

- **Started**: 2026-01-13
- **Last Updated**: 2026-01-24
- **Status**: Complete
- **ADR**: [010-temporal-workflow-engine](/docs/adr/010-temporal-workflow-engine.md)

## Context

This is a sync engine for the X API that began as a small project to strategically use the free tier (1 req/15 min).
We discovered it is too restrictive and alternatives carry risk. The foundation was refactored to accommodate multiple
plans and strategies, but the primary path will use the paid API tier (5 req/15 min) with optional enrichment sources
(Search API, Bird/streipete, internal GraphQL, etc.) as needed. The system can run as workflows, an ad hoc CLI, or a
service.

## Architecture Direction and Boundaries

- Temporal is the default execution path for sync and enrichment operations.
- SQLite remains the local source of truth for content and enrichment state.
- The scraper emits structured data for downstream systems (Convex is a candidate for UI/routing, but not required).
- In scope: X auth, rate limits, pagination, bookmark sync, stub enrichment, future topic monitoring and engagement tracking.
- Out of scope: content classification/NLP, cross-platform aggregation, inbox/UI layer.

## Current Implementation Status

### Completed Work

- [x] Temporal worker and client setup (`src/temporal/worker.ts`, `src/temporal/client.ts`)
- [x] Activity layer (fetch, store, delete, query, state) under `src/temporal/activities/`
- [x] SyncWorkflow with pagination, delete backlog, signals, and queries
- [x] EnrichWorkflow with batching, progress queries, and rate limit sleeps
- [x] Workflow CLI (`src/commands/workflow.ts`)
- [x] Temporal scripts (`pnpm temporal:dev`, `pnpm dev:worker`)
- [x] SyncEngine extracted and used by CLI (`src/lib/sync-engine.ts`)
- [x] SyncWorkflow runs via SyncEngine to avoid drift
- [x] Temporal is the default sync execution path with `--local` escape hatch
- [x] Workflow determinism aligned via workflow time helpers
- [x] Rate limit header parsing and propagation to RateLimiter
- [x] Temporal activities return rate-limit snapshots and workflows sleep durably
- [x] SyncEngine delete respects API return values before marking deleted
- [x] Targeted DB accessors for stub count and active bookmark lookup to avoid O(N) scans
- [x] Resume support via `sync_state` for local CLI and workflow start (`--resume`)
- [x] fetchTweetDetails implemented in X data source and used by enrichment activity

### Partial or Needs Alignment

- [x] Output normalization: CLI console output separated from JSONL logger output

## Outstanding Issues and Gaps (Rolled Up)

P0 - Required to complete Temporal integration (complete)

- [x] Workflow determinism: remove Date.now/new Date usage from workflows and move timestamps to activities.
- [x] Delete correctness: SyncEngine ignores delete return value and can mark failed deletes as deleted.
- [x] Temporal default: CLI should start workflows by default with a `--local` escape hatch.
- [x] Rate limit consistency: activities must update from headers and pre-throttle, not only on 429.

P1 - Near term

- [x] Performance: `getStubCount()` reads all tweets; delete activity scans all bookmarks per delete.
- [x] Registry-driven source selection and tier capability gating.
- [x] Resume support using `sync_state`.
- [x] Resume state management commands (inspect/clear).
- [x] Tests for delete/verify/enrich activities and SyncEngine resume handling.
- [x] Tests for SyncEngine error handling/retries and rate limiter behavior.
- [x] Logging/output normalization (console vs JSONL).

P2 - Later / roadmap

- [x] Durable delete queue with retry/backoff.
- [x] `tweet_edges` graph for reply/quote/retweet relationships.
- [x] Optional FTS5 for `tweets.text` search.
- [x] TopicMonitorWorkflow and EngagementTrackingWorkflow scaffolding.
- [x] Structured event outbox for downstream consumers (Convex or other services).
- [ ] Outbox dispatcher: poll + publish with pluggable sink (Convex/JSONL/webhook).
- [ ] Outbox payload expansion and filtering (tweet/user/media snapshots).

## Action Plan to Complete Temporal Integration

### Phase A - Make Temporal the default (P0)

- [x] Switch `pnpm dev sync` to start SyncWorkflow by default; add `--local` to run SyncEngine directly.
- [x] Fix workflow determinism: use workflow time utilities, remove Date.now/new Date from workflow code.
- [x] Respect delete return values in SyncEngine before marking records deleted.
- [x] Wire RateLimiter into Temporal activities to update from headers and pre-throttle.
- [x] Acceptance: CLI uses workflows by default, workflows replay cleanly, delete counts are accurate, rate limit waits match headers.

### Phase B - Parity and resume (P1)

- [x] Consolidate sync logic to avoid drift (share SyncEngine or shared phase helpers used by workflows).
- [x] Implement resume support via `sync_state` with a `--resume` flag (local + Temporal).
- [x] Add `sync_state` inspect/clear commands for resume reset.
- [x] Use source registry for best-capability selection and tier gating.
- [x] Add targeted DB accessors (stub count, bookmark lookup by tweet_id) to remove O(N) scans.
- [x] Acceptance: CLI and workflows use the same core logic, resume works, and registry selection + clear command are in place.

### Phase C - Hardening (P1/P2)

- [x] Tests: rate limiter, SyncEngine retries, activities (fetch/store); delete/verify/enrich covered.
- [x] Output normalization: `notifications` for console, `logger` for JSONL.
- [x] Durable delete queue with retry/backoff.
- [x] Acceptance: touched areas have tests, delete failures persist and retry, logs are consistent.

## Future Feature Considerations (Post-Temporal)

- Conversation awareness: persist `tweet_edges` and render linear topic views with replies/quotes.
- Content context: fetch linked content for context (forums/media) behind explicit risk profiles.
- Topic monitoring workflows: scheduled ingestion for high-activity topics and engagement spikes.
- Structured event emission: outbox table or JSONL event stream for downstream routing/classification.
- Terminal UI plan: credentials/env manager, task runner, status indicators, progress bars, and error notifications.

## Related

- [GOAP Enrichment Planner](/docs/ideas/goap-enrichment-planner.md)
