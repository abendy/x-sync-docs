# Plan: Thread-Aware Enrichment with `get-posts-by-ids`

**Status:** Implemented through P4 + hardening complete; P5 rollout validation pending
**Created:** 2026-02-20
**Updated:** 2026-03-04
**Source:** Endpoint and workflow assessment from current repo + X API docs

## Context

Folder bookmark sync returns mostly ID-only records (about 20 at a time). This plan introduced a batch-first enrichment baseline plus bounded context-expansion modes so we can preserve useful thread context without cost/runtime blowups.

## Current Implementation Snapshot (as of 2026-03-04)

1. Batch lookup is implemented for enrichment hydration via `getTweetsByIds` and `fetchTweetDetailsBatch`.
2. Enrichment execution is batch-first with deterministic ordering and per-ID outcomes (`ok | unavailable | failed`).
3. `atomic` remains the default mode; `origin`, `conversation`, and `quotes` are opt-in and capped.
4. Run-level budgets, stop reasons, and telemetry are implemented and exposed in workflow progress.
5. Code-review hardening fixes are merged (strict conversation caps, duplicate accounting, fallback partial-result preservation).
6. Remaining work is rollout validation and metrics capture (`P5-02` through `P5-05`).

### Code Evidence

1. Batch endpoint builder and lookup cap: `src/lib/api/client/endpoints.ts`
2. Batch API client call: `src/lib/api/x-api-client.ts`
3. Batch datasource lookup + mixed outcome normalization: `src/sources/x-api.ts`
4. Batch fetch activity + sequential fallback behavior: `src/temporal/activities/fetch.ts`
5. Batch enrich activity + origin/conversation/quote expansion: `src/temporal/activities/store.ts`
6. Workflow budget/stop-reason accounting: `src/temporal/workflows/enrich/pass.ts`, `src/temporal/workflows/enrich/index.ts`
7. Hardening regressions: `tests/temporal-activities.test.ts`, `tests/temporal-fetch-activities.test.ts`
8. Folder endpoint limitation context: `docs/issues/folder-endpoint-limitation.md`

## Goals

1. Reduce enrichment API request count for folder bookmark runs while preserving current correctness.
2. Keep default mode safe (`atomic`) and bounded.
3. Add context expansion as explicitly bounded, policy-driven behavior.
4. Preserve deterministic Temporal workflow behavior and idempotent persistence.

## Non-Goals

1. No unbounded graph traversal.
2. No default-on `conversation` or `quotes` expansion in initial rollout.
3. No conversion of discovered related posts into bookmark rows.
4. No recursive child-workflow fan-out in Phase 1 or Phase 2.

## Implementation Readiness Gate (Locked)

- [x] Lock batch contract: per-ID outcomes (`ok | unavailable | failed`) plus retryability classification.
- [x] Lock config keys and defaults for all caps/budgets.
- [x] Lock persistence semantics for discovered posts and unavailable marking rules.
- [x] Lock deterministic ordering and dedupe rules (`seen` behavior within a pass).
- [x] Lock run-level budget model and fallback behavior when exhausted.
- [x] Lock telemetry schema and acceptance thresholds.
- [x] Lock rollout gates (`atomic` first, context expansion opt-in only).
- [x] Lock test matrix (unit, workflow, integration, parity regression).

## Assessment

### Is `get-posts-by-ids` a good enrich candidate?

Yes. For folder-based batches, it is a strong fit:

1. It aligns with the existing workload shape (small known ID sets).
2. It reduces request count by batching IDs up to endpoint limit.
3. It improves enrich latency and rate-limit pressure for each pass.

### Can it fully solve thread/reply/quote expansion?

Partially:

1. It hydrates known IDs well.
2. It does not discover unknown replies in a conversation by itself.
3. It does not replace quote retrieval endpoints.
4. Full thread context still needs controlled conversation/quote discovery flows.

## Proposed Enrichment Levels

### Level 0: `atomic` (default baseline)

1. Hydrate only bookmarked tweet IDs.
2. Include immediate referenced tweets returned by expansions.
3. No traversal/search fan-out.

### Level 1: `origin` (light context)

1. For replies, walk `replied_to` parent chain toward root.
2. Stop at strict depth and related-record caps.
3. Prioritize context ("where this post sits in thread") over breadth.

### Level 2: `conversation` (bounded expansion)

1. Use `conversation_id` search to fetch sibling/descendant replies.
2. Apply hard limits (records, pages, recency).
3. Keep opt-in/profile-gated because fan-out can be high.

### Level 3: `quotes` (bounded quote expansion)

1. Fetch quote posts for seed posts (or resolved origin post).
2. Apply hard limits and recency filters.
3. Keep separate from conversation mode to control cost.

## Contracts and Defaults

### Batch Contract (Required)

`fetchTweetDetailsBatch(ids)` must return per-ID outcomes, not a single aggregate success/failure.

1. `ok`: full record returned and writable.
2. `unavailable`: inaccessible/deleted/protected; terminal for this run.
3. `failed`: API/runtime failure with explicit `retryable: boolean`.

The result should include a stable per-ID map and optional rate-limit snapshot so workflow logic can update counters and wait state deterministically.

### Required Config Keys and Initial Defaults

1. `enrich.mode = "atomic"`
2. `enrich.maxIdsPerBatch = 100` (clamped to endpoint max)
3. `enrich.maxOriginDepth = 8`
4. `enrich.maxRelatedPostsPerSeed = 100`
5. `enrich.maxRelatedPostsPerRun = 1000`
6. `enrich.maxConversationPosts = 200`
7. `enrich.maxConversationPages = 5`
8. `enrich.maxQuotePosts = 100`
9. `enrich.maxDiscoveryAgeDays = 30`
10. `enrich.maxApiCallsPerRun = 200`

These are initial defaults for rollout; adjust only after telemetry review.

## Persistence Semantics (Required)

1. Seed tweets are bookmarks; discovered context tweets are tweet rows only.
2. No bookmark rows are created for discovered context records.
3. Unavailable marking applies to explicitly requested IDs only (seed or directly requested ancestor IDs), not opportunistically discovered IDs.
4. Deduplicate write inputs before persistence so the same tweet ID is upserted once per write cycle.
5. Keep edge writes upsert-only and idempotent (`tweet_edges` conflict-safe behavior).

## Temporal Execution Model (Required)

1. All network calls and pagination remain in activities.
2. Workflows orchestrate deterministic state transitions only.
3. Conversation and quote expansion must use page/batch-sized activity calls, not a single long-running activity.
4. Process IDs in deterministic order (sorted IDs + per-pass `seen` set).
5. Track run-level budget in workflow state and stop with explicit reason codes when exhausted.

### Budget Stop Reasons

1. `limit_reached`
2. `api_call_budget_exhausted`
3. `related_post_budget_exhausted`
4. `mode_cap_reached`
5. `rate_limited_deferred`

## Architecture Plan

### Phase 1: Batch Hydration Foundation (`get-posts-by-ids`)

1. Add endpoint builder and shared endpoint-limit constant for batched lookup by IDs.
2. Add client method (`getTweetsByIds(ids)`), preserving existing single-ID method.
3. Add datasource batch API (`fetchTweetDetailsBatch(ids)`), preserving existing single-ID API.
4. Add Temporal activity surface for batch enrichment outcomes and keep `enrichRecord` for compatibility during migration.
5. Update enrich pass to batch process IDs first with deterministic ordering and unchanged per-ID outcome semantics.

**Exit criteria:**

1. `atomic` behavior parity is validated.
2. Request count drops materially in folder ID-only flows.
3. No increase in duplicate writes or error rate.

### Phase 2: Policy, Budget, and Telemetry

1. Add mode/cap config keys with defaults listed above.
2. Add run-level budget tracking and stop reasons.
3. Add telemetry counters by mode and stop reason.
4. Document cost and latency tradeoffs in `docs/cost-model.md`.

**Exit criteria:**

1. Budget stop behavior is deterministic and observable.
2. Metrics are sufficient to compare baseline vs batch.

### Phase 3: Origin Chain Expansion

1. Resolve `replied_to` ancestry with depth and related-post caps.
2. Batch fetch missing ancestors where possible.
3. Persist ancestry records/edges idempotently.

**Exit criteria:**

1. High success rate on reconstructing parent chains for reply seeds.
2. No cap overruns and no workflow non-determinism issues.

### Phase 4: Conversation and Quote Expansion (Opt-In)

1. Implement `conversation_id` search expansion with strict page/post/time caps.
2. Implement quote retrieval expansion with strict caps and recency window.
3. Keep both behind explicit mode flags and rollout gates.

**Exit criteria:**

1. Fan-out remains bounded under all tested profiles.
2. Cost and latency remain within accepted thresholds.

## Guardrails

1. Hard per-seed, per-conversation, and per-run caps.
2. Recency window cap for conversation/quote discovery.
3. Deterministic ordering + idempotent writes.
4. Explicit budget stop reasons and safe fallback behavior.
5. `atomic` remains the default fallback when expansion fails or caps trigger.

## Success Criteria

1. `atomic` mode reduces request count by at least 50% in typical folder ID-only enrichment batches.
2. `atomic` mode preserves behavior parity versus current single-ID enrich path (except fewer API calls).
3. p95 enrich pass duration improves by at least 30% on representative folder datasets.
4. `origin`, `conversation`, and `quotes` modes respect caps with zero unbounded fan-out incidents.
5. Duplicate bookmark creation from discovered context remains zero.

## Test Plan (Required)

1. Unit tests for batch normalization with mixed `ok`, `unavailable`, and `failed` outcomes in one response.
2. Unit tests for config cap clamping and invalid-policy fallback to `atomic`.
3. Workflow tests for deterministic ordering, budget depletion, and stop reasons.
4. Integration tests for deduped writes when related records overlap across seeds.
5. Regression tests for `atomic` parity against current baseline behavior.

## Rollout Plan

1. Release Phase 1 (`atomic` batching only) first.
2. Measure two full sync cycles of request count, p95 latency, and error/unavailable rates.
3. Enable `origin` for a limited profile if metrics are stable.
4. Enable `conversation` and `quotes` only after cap behavior is proven stable.

## Open Questions

1. Should `origin` become the default after rollout evidence, or remain opt-in?
2. Do we want per-folder policy overrides for high-signal folders?
3. Should child workflows be introduced later for very large context expansions (post-Phase 4 only)?

## Initial Implementation Targets

1. `src/lib/api/client/endpoints.ts`
2. `src/lib/api/x-api-client.ts`
3. `src/lib/api/types.ts`
4. `src/sources/types.ts`
5. `src/sources/x-api.ts`
6. `src/temporal/activities/fetch.ts`
7. `src/temporal/activities/store.ts`
8. `src/temporal/shared/activity-types.ts`
9. `src/temporal/workflows/enrich/pass.ts`
10. `docs/cost-model.md`
11. `README.md`

## References

1. <https://docs.x.com/x-api/posts/get-posts-by-ids>
2. <https://docs.x.com/x-api/fundamentals/conversation-id>
3. <https://docs.x.com/x-api/posts/search/introduction>
4. <https://docs.x.com/x-api/posts/get-quoted-posts>
5. <https://docs.x.com/x-api/fundamentals/rate-limits>

## Notes

This plan intentionally separates "hydration batching" from "context expansion." Batch hydration should land first as a low-risk improvement, then context modes can be layered in with strict caps and observability.
