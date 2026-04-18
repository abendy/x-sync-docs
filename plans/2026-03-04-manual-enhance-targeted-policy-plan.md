# Plan: Manual Enrich as Targeted Policy Execution

**Status:** Completed
**Created:** 2026-03-04
**Updated:** 2026-03-05
**Source:** Post-v0.23.x cleanup discussions and sync/enrich retry behavior review
**Ref:** a961f5

## Context

`sync` should remain fast and predictable: ingest + baseline enrich for newly synced bookmarks.
Manual enrich should be the place where heavier, intentional policy is applied to explicit targets.

The key issue we are solving is retry behavior: previous runs should not create uncontrolled churn, but recoverable transient failures should still get meaningful retries.

## Decision Summary

1. Keep sync enrich baseline-only and deterministic.
2. Use policy-lane affinity for retry eligibility (not exact policy-value matching).
3. Retry transient failures in-run first (pause/backoff), then allow bounded cross-run retries in the same lane.
4. Keep non-atomic policy execution manual-first.
5. Keep workflow logic code-defined; keep policy data declarative.
6. Move policy settings to registry JSON and retire `ENRICH_*` policy env vars.

## Retry and Backlog Model

### Policy Lane Affinity

1. Introduce a stable `policyLane` identity for retry routing.
2. Initial lane examples:
   - `sync.atomic`
   - `manual.origin`
   - `manual.conversation`
   - `manual.quotes`
3. Backlog items are retry-eligible only when lane matches the current run lane.
4. This avoids stranding retries when minor policy values change, while still preventing cross-policy churn.

### Sync Run Selection Order

1. Process current-run stubs first.
2. Then process same-lane carryover stubs/failures with a strict cap/timebox.
3. Do not auto-sweep non-matching lanes from sync.

### Outcome Taxonomy

1. `enriched`: successful hydrate.
2. `unavailable`: confirmed inaccessible/missing from API response semantics.
3. `deferred_transient`: retryable failure (timeout/network/5xx/rate-limit interruption).
4. `failed_terminal`: non-retryable failure.
5. `skipped_budget`: not attempted due to budget/timebox/cap.

### Retry Policy

1. In-run transient retry:
   - pause/backoff and retry before leaving the run,
   - default cap: `3` attempts in the same run.
2. Cross-run transient retry (same lane only):
   - bounded by persisted retry metadata,
   - default cap: `6` total attempts before terminal classification.
3. Persist retry metadata:
   - `attempt_count`
   - `next_retry_at`
   - `last_error`
   - `last_error_kind`
   - `policy_lane`
4. No infinite retries.

## Workflow and Policy Contract

1. Do not build a generic endpoint DSL.
2. Keep workflow/activity logic hardcoded and deterministic.
3. Policy remains declarative configuration over known modules.
4. Resolve policy profile at workflow start and snapshot it into workflow input.
5. Log policy identity (`profileName`, `policyLane`, snapshot hash/version) at run start.
6. Clamp all policy settings against hardcoded safety bounds in code.

## X API Ownership Matrix

### Sync-Domain Endpoints

1. `GET /2/users/:id/bookmarks/folders`
2. `GET /2/users/:id/bookmarks/folders/:folder_id`
3. `DELETE /2/users/:id/bookmarks/:tweet_id`

### Enrich-Domain Endpoints (Current)

1. `GET /2/tweets?ids=...` (batch hydration baseline)
2. `GET /2/tweets/search/recent` (conversation expansion mode)
3. `GET /2/tweets/:id/quote_tweets` (quotes expansion mode)

### Deferred/Not in Current Manual-Enhance Scope

1. `GET /2/tweets/search/stream`
2. `GET /2/tweets/:id/retweeted_by`
3. `GET /2/tweets/:id/retweets`

## Dynamic vs Hardcoded Boundaries

### Dynamic (Registry JSON)

1. Mode/module toggles.
2. Per-mode limits and budgets.
3. Retry caps and cooldown windows.
4. Workflow default profile mapping.
5. Manual profile definitions.

### Hardcoded (Code)

1. Workflow state machines and activity orchestration.
2. Endpoint implementations and request/response adapters.
3. Error classification rules and fallback paths.
4. Deterministic ordering rules.
5. Absolute safety clamps.

## Policy Registry Integration Plan

1. Keep the registry subsystem.
2. Wire manual enrich profile selection first.
3. Keep sync user-facing policy selection disabled.
4. If sync references profile metadata internally, keep sync invariants:
   - run-scoped priority for current-run stubs,
   - same-lane carryover only,
   - API-call budget disabled for sync child enrich baseline,
   - strict caps/timebox.

## Configuration Direction (Next)

1. Move policy settings into `config/enrichment-policy-profiles.v1.json`.
2. Remove `ENRICH_*` policy env vars from runtime policy loading.
3. Keep non-policy env vars only (auth, logging, Temporal, media paths, etc.).
4. Update docs and tests to reflect JSON as policy source of truth.
5. Decide whether `ENRICH_POLICY_PROFILE_REGISTRY_PATH` remains as an override or is removed.

## Scope for Next Implementation Pass

1. Manual target-driven enrich inputs (`--tweet-id` repeatable and/or file list).
2. Deterministic target set resolution before traversal.
3. Policy-lane-aware record selection.
4. In-run transient pause/backoff retry loop.
5. Cross-run bounded retry metadata and filtering.
6. Clear metrics per outcome class and lane.

## Non-Goals

1. No intent queue / dispatcher / lane-worker runtime.
2. No large schema redesign unrelated to retry metadata.
3. No change to sync delete/rate-limit orchestration model.

## Exit Criteria

1. Sync remains fast and bounded while handling same-lane carryover safely.
2. Manual enrich can intentionally apply heavier policies to explicit targets.
3. Retry behavior is bounded, explainable, and observable.
4. Policy source of truth is clear and test-covered.

## Completion

All defined scope and exit criteria were met across Chunks 1-6.
Post-implementation follow-up also completed:

1. README enrichment docs were reorganized and clarified.
2. ADR set updated with targeted manual execution architecture (`ADR 028`) and registry clarification (`ADR 027`).
3. Policy registry config moved to local-file model with committed examples under `config/examples/`.
