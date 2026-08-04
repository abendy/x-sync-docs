# Task: Thread-Aware Enrichment with `get-posts-by-ids` (Narrative Writeup)

**Status:** Implemented through P4 + hardening complete; P5 rollout validation pending
**Created:** 2026-02-21
**Plan Reference:** `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`

## Context

Folder bookmark sync currently returns mostly ID-only tweet records, which means enrichment has to follow up with one request per tweet (`GET /2/tweets/:id`). This works functionally, but it is expensive in request count, slower than necessary, and does not create a clean path for optional thread-aware context expansion.

The core opportunity is to switch the enrichment baseline from single-ID fetches to batched fetches (`get-posts-by-ids`) while preserving existing behavior and safety guarantees. Once that baseline is stable, we can layer in bounded context expansion modes (`origin`, `conversation`, `quotes`) behind strict policy limits.

## Intention

This effort is intended to do two things well:

1. Improve enrichment efficiency immediately with low-risk batching in `atomic` mode.
2. Introduce a controlled architecture for richer thread context without unbounded crawl behavior.

The design prioritizes deterministic workflow behavior, idempotent writes, and rollout safety over maximum feature velocity.

## What Success Looks Like

The implementation is successful when:

1. `atomic` mode produces the same effective output quality as today, but with materially fewer API requests and faster pass times.
2. Context expansion modes are available as opt-in policies with clear, enforceable limits.
3. The workflow remains deterministic under retries, continuation, and partial failures.
4. Operational behavior is observable enough to make rollout decisions from real metrics, not intuition.

## Scope

This task includes:

- Batch hydration foundation (`get-posts-by-ids`)
- Policy and budget controls
- Origin-chain expansion
- Conversation and quote expansion (opt-in)
- Rollout instrumentation and validation

This task explicitly excludes:

- Unbounded graph traversal
- Default-on conversation/quote fan-out in early rollout
- Converting discovered context tweets into bookmark rows

## Current-State Snapshot

As implemented today, enrichment in Temporal is batch-first (`get-posts-by-ids` via `getTweetsByIds`) and still preserves per-ID outcomes (`enriched`, `failed`, `unavailable`, `skipped`) with deterministic ordering and idempotent writes.

The remaining gap is rollout validation evidence (request reduction and staged mode enablement), not core feature implementation.

## Implementation Narrative

### Phase 0: Readiness Lock

Before coding, we lock key contracts and defaults so implementation cannot drift:

- Batch result shape must be per-ID (`ok | unavailable | failed`) with retryability metadata for failures.
- Config keys and default caps must be explicit (`enrich.*` limits and budgets).
- Persistence semantics for discovered records must be frozen (tweet rows only; never bookmarks).
- Run-level budget stop reasons must be fixed and enumerable.
- Acceptance thresholds and test matrix must be agreed up front.

The goal of this phase is not output volume. The goal is eliminating ambiguity.

### Phase 1: Batch Hydration Foundation (`atomic`)

We start with the lowest-risk structural change: batch known IDs without adding search traversal.

At the API layer, we add endpoint builders/types/client methods for `get-posts-by-ids` and preserve current single-ID methods for compatibility during migration. At the datasource layer, we add a batch fetch method that normalizes mixed outcomes into deterministic per-ID results.

At the Temporal layer, workflows still orchestrate deterministically while network access remains inside activities. The enrich pass switches from per-record network calls to deterministic batch processing with a per-pass dedupe set and stable ordering.

This phase is complete only if parity is preserved while request count drops.

### Phase 2: Policy, Budget, and Telemetry

With batch hydration stable, we introduce enforcement controls:

- Mode and limit settings (`enrich.mode`, caps, page limits, age windows)
- Run-level budget accounting (API calls and related-record budgets)
- Explicit stop reasons for every budget-driven short-circuit
- Mode-aware counters and structured logging

This phase creates the operational control plane needed before broader context expansion.

### Phase 3: Origin Chain Expansion

Origin mode adds parent-chain context for replies in a bounded way. For each seed tweet, we resolve `replied_to` ancestry, batch fetch missing ancestors, and stop on strict depth/count caps. Persistence remains idempotent, and discovered records are stored as tweets only.

The value here is contextual clarity ("where this sits in a thread") without broad conversation crawl behavior.

### Phase 4: Conversation and Quote Expansion (Opt-In)

Only after budget/telemetry controls are in place do we add broader context fetches:

- `conversation_id`-based discovery with strict page/post/time limits
- Quote discovery with strict limits and recency windows

Both remain explicitly gated and non-default during initial rollout. Every discovery step is budget-checked to prevent fan-out runaway behavior.

### Phase 5: Rollout and Validation

Rollout is staged:

1. Ship `atomic` batching first.
2. Observe at least two full sync cycles.
3. Enable `origin` for a narrow profile if metrics are healthy.
4. Enable conversation/quotes only after bounded behavior is proven.

We close the task only when acceptance metrics are met and docs reflect shipped behavior.

## Architecture Notes

The implementation should preserve these architectural invariants:

1. Workflow code remains deterministic and orchestration-only.
2. Activities own external I/O and pagination.
3. Write paths stay idempotent and conflict-safe.
4. Default behavior remains safe (`atomic`) when limits/errors trigger.

## Primary Files Likely Touched

- `src/lib/api/client/endpoints.ts`
- `src/lib/api/x-api-client.ts`
- `src/lib/api/types.ts`
- `src/sources/types.ts`
- `src/sources/x-api.ts`
- `src/temporal/activities/fetch.ts`
- `src/temporal/activities/store.ts`
- `src/temporal/shared/activity-types.ts`
- `src/temporal/workflows/enrich/pass.ts`
- `docs/cost-model.md`
- `README.md`

## Risk Areas and Mitigations

### Mixed-outcome batch handling

Risk: Losing per-ID semantics in aggregate handling can blur retry behavior.
Mitigation: Normalize every response to per-ID outcome objects with explicit retryability.

### Workflow determinism drift

Risk: Non-deterministic ordering or hidden mutable sets can create replay divergence.
Mitigation: Sort IDs before batching and maintain explicit per-pass dedupe state.

### Silent fan-out growth

Risk: Context expansion can exceed expected cost/latency.
Mitigation: Hard caps, run-level budgets, stop reasons, and staged rollout gates.

### Data duplication regressions

Risk: Overlapping seeds/context paths can cause duplicate writes or bookmark pollution.
Mitigation: Dedup before persistence and maintain discovered-context-as-tweet-only semantics.

## Verification Approach

Verification should include:

1. Unit tests for batch normalization with mixed outcomes.
2. Workflow tests for ordering determinism and budget stop conditions.
3. Integration tests for overlap dedupe and idempotent persistence.
4. Parity regression for `atomic` output quality vs current baseline.
5. Rollout metric review for request reduction, latency, and error stability.

## Suggested Decision Log Entries

As implementation progresses, capture decisions in this doc (or linked ADRs) for:

1. Final default cap values chosen after telemetry.
2. Whether `origin` becomes default after rollout.
3. Whether child workflows are needed for later high-volume expansion modes.

## Notes

This narrative writeup is intentionally prose-first. It is meant to explain intent, sequencing, tradeoffs, and operational posture. Use the tracker document for execution status and granular task completion.

## Progress Update (2026-02-21)

- Completed Phase 1 foundation for `atomic` batch hydration (`get-posts-by-ids`) across API, datasource, Temporal activities, and enrich workflow pass orchestration.
- Added deterministic batch processing behavior (stable ID ordering + per-pass dedupe) with backward-compatible single-record fallback.
- Added tests for mixed batch outcomes, overlap dedupe behavior, and batch workflow path.
- Updated README to document atomic batching behavior.
- Completed Phase 2 policy controls: config defaults/clamping, run-level API + related-post budgets, explicit stop reasons, and workflow telemetry/logging.
- Added cost/latency tradeoff documentation in `docs/cost-model.md`.
- Completed Phase 3 origin expansion: bounded `replied_to` parent-chain traversal with cross-seed ancestor dedupe and deterministic ordering.
- Added batch `apiCallsUsed` accounting from activities to workflow budget tracking to reflect multi-call batch activity behavior.
- Added tests for origin depth/cap behavior, cross-seed dedupe, and retry idempotent edge persistence.
- Completed Phase 4 opt-in context expansion for `conversation` and `quotes` modes with strict page/post/time caps and explicit default-off gating.
- Added activity-level discovery calls for conversation search and quote retrieval, enforcing per-step API-call budget checks from workflow policy.
- Added bounded-fanout tests for conversation and quote expansion behavior, including discovery age-window filtering.
- Completed rollout chunk `P5-01`: atomic batching remains shipped/default (`ENRICH_MODE=atomic`) while non-atomic modes stay opt-in.
- Refreshed operator docs to reflect current policy behavior and cost model tradeoffs (`README.md`, `docs/cost-model.md`).
- Remaining for rollout closeout: record request-count reduction evidence across live sync cycles and complete staged enablement metrics.

## Progress Update (2026-03-04)

- Code review findings for thread-aware enrichment are fully addressed and documented in `.project/tasks/2026-02-22-thread-aware-enrichment-code-review-findings.md`.
- Implementation status is aligned across docs as: `P0-P4 complete`, hardening complete, `P5 rollout validation pending`.
- Remaining work is tracked in the implementation checklist under `P5-02` through `P5-05`.
