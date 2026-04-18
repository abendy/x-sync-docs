# Plan: Intent-Driven Enrichment Queue and Policy Lanes

**Status:** Parked on branch `backlog/enrich-gates-threading` (de-scoped from `develop` for lean `v0.24.0` release path)
**Created:** 2026-02-22
**Updated:** 2026-03-04
**Source:** Current enrich/sync workflow behavior + policy isolation requirements

## Direction Update (2026-03-04)

This plan remains a useful expansion path, but the active release line intentionally took a slimmer approach:

1. keep sync-centric execution and policy profiles per workflow,
2. keep `get-posts-by-ids` batching and bounded enrich modes,
3. defer dispatcher/lane runtime and rollout gate surfaces.

The full intent-runtime implementation remains preserved on `backlog/enrich-gates-threading` for future iteration when we are ready to re-open advanced async orchestration.

See scope-trim audit and cherry-pick rationale:
`.project/tasks/2026-03-04-v0.23.1-scope-trim-audit.md`.

## Executive Summary

Current enrichment is run-scoped and policy-global. That works for one workload (`sync` + `atomic`) but does not scale to mixed intent workloads with different urgency/cost profiles.
This plan introduces a durable intent queue with lane-based dispatching, lease-safe processing, and per-intent policy execution while preserving existing sync behavior as a fallback during rollout.

## Problem

Current behavior cannot cleanly express all of these at once:

1. low-latency sync hydration,
2. manual follow-conversation expansion,
3. topic/keyword discovery independent of `conversation_id`.

A single global run policy causes priority inversion and budget contention across unrelated workloads.

## Goals

1. Add a durable enrichment intent queue with deterministic lifecycle semantics.
2. Process intents in isolated lanes with independent budgets and concurrency.
3. Preserve deterministic Temporal orchestration and idempotent persistence.
4. Keep sync hydration fast/cheap by default.
5. Provide clear cost/latency observability per lane and per intent type.

## Non-Goals

1. No unbounded crawl/search behavior.
2. No big-bang replacement of existing enrich path.
3. No default-on high-fanout policy for sync.
4. No bookmark-row creation from discovered non-bookmark context.
5. No per-lane table split in first iteration (single table + indexes first).

## Confirmed Current State

1. Sync can trigger enrich repeatedly while delete continues.
2. Enrich in sync mode is singleton trigger-driven (`awaitTriggers`) with one run-level policy.
3. Stub selection is global and not intent-aware.
4. Existing enrich modes are bounded, but one mode applies per run.

### Code Evidence

1. `src/temporal/workflows/sync/page-runner.ts`
2. `src/temporal/workflows/sync/enrich-orchestrator.ts`
3. `src/temporal/workflows/sync/finalize.ts`
4. `src/temporal/workflows/enrich/loop.ts`
5. `src/lib/config.ts`
6. `src/temporal/workflows/enrich/index.ts`
7. `src/temporal/activities/query.ts`
8. `src/lib/db/tweet-query-repo.ts`
9. `src/temporal/activities/store.ts`

## Decision Summary

We will implement:

1. A single durable `enrichment_intents` queue table with dedupe and lease columns.
2. A fixed-ID dispatcher workflow that leases intents by lane and dispatches lane workers.
3. Lane worker workflows that process leased intents deterministically with policy-bound budgets.
4. CAS-style lease token checks for `ack/fail/requeue` correctness.
5. Weighted fair lane scheduling with starvation prevention.
6. Shadow-mode rollout where legacy enrich remains the authoritative fallback until gates pass.

## Phase 0 Lock Record (Completed 2026-02-22)

Phase 0 was completed as a contracts-first slice to lock behavior before schema and workflow rollout:

1. Added shared intent lifecycle, lease mutation, lane scheduling, stop reason, and rollout matrix contracts.
2. Added deterministic policy/rule fingerprinting and dedupe key helpers with stable normalization.
3. Added contract tests that lock legal transitions, lane weighting, starvation floor, and rollout ownership mapping.
4. Added dedupe tests that lock deterministic hashing and topic query/target normalization.

### Evidence

1. `src/temporal/shared/intent-types.ts`
2. `src/lib/intents/dedupe.ts`
3. `src/temporal/shared/types.ts`
4. `tests/intent-policy-queue-contracts.test.ts`
5. `tests/intent-dedupe.test.ts`

### Validation

1. `pnpm exec vitest run tests/intent-policy-queue-contracts.test.ts tests/intent-dedupe.test.ts`
2. `pnpm test`

## Architectural Invariants

1. Workflows orchestrate deterministically; activities own all network I/O and pagination.
2. Tweet/media/user writes remain idempotent upserts.
3. Discovered context records remain tweet rows only.
4. Per-intent and per-lane budgets are enforced before each discovery step.
5. Every terminal outcome is explicit (`done`, `dead_letter`, `expired`, `cancelled`).

## Intent Model

### Intent Types

1. `sync_minimal`
2. `follow_conversation`
3. `topic_hunt`

### Lanes

1. `urgent-sync`
2. `analysis`
3. `background-topic`

### Required Intent Fields

1. Identity: `intent_id`, `intent_type`, `source`, `source_scope`, `tweet_id` (nullable).
2. Policy: `mode`, caps, recency window, optional rule payload.
3. Scheduling: `lane`, `priority`, `not_before`, `expires_at`.
4. Execution: `status`, `attempt_count`, `max_attempts`, `last_error_code`, `last_error_message`.
5. Lease: `leased_by`, `lease_token`, `leased_until`.
6. Dedupe: `dedupe_key`, `policy_fingerprint`, `rule_fingerprint`.
7. Audit: `created_at`, `updated_at`, `started_at`, `finished_at`, `dead_letter_at`.

## Schema and Index Plan

### Table: `enrichment_intents` (new)

Minimum columns:

1. `id TEXT PRIMARY KEY`
2. `intent_type TEXT NOT NULL`
3. `lane TEXT NOT NULL`
4. `priority INTEGER NOT NULL`
5. `status TEXT NOT NULL`
6. `tweet_id TEXT NULL`
7. `source TEXT NOT NULL`
8. `source_scope TEXT NOT NULL`
9. `policy_json TEXT NOT NULL`
10. `rules_json TEXT NULL`
11. `policy_fingerprint TEXT NOT NULL`
12. `rule_fingerprint TEXT NULL`
13. `dedupe_key TEXT NOT NULL`
14. `not_before TEXT NULL`
15. `expires_at TEXT NULL`
16. `attempt_count INTEGER NOT NULL DEFAULT 0`
17. `max_attempts INTEGER NOT NULL DEFAULT 8`
18. `leased_by TEXT NULL`
19. `lease_token TEXT NULL`
20. `leased_until TEXT NULL`
21. `last_error_code TEXT NULL`
22. `last_error_message TEXT NULL`
23. `created_at TEXT NOT NULL`
24. `updated_at TEXT NOT NULL`
25. `started_at TEXT NULL`
26. `finished_at TEXT NULL`
27. `dead_letter_at TEXT NULL`

### Required Indexes

1. `idx_intents_lane_ready` on `(lane, status, not_before, priority, created_at)`
2. `idx_intents_lease_expiry` on `(status, leased_until)`
3. `idx_intents_expires` on `(status, expires_at)`
4. `idx_intents_source_scope` on `(source_scope, intent_type, created_at)`
5. unique `idx_intents_dedupe_active` on `(dedupe_key, status)` for active statuses only (implemented via partial index)

## Lifecycle and State Transitions

### Statuses

1. `queued`
2. `leased`
3. `done`
4. `failed_retryable`
5. `dead_letter`
6. `expired`
7. `cancelled`

### Transition Rules

1. `queued -> leased` (lease acquired)
2. `leased -> done` (successful completion)
3. `leased -> failed_retryable` (retryable failure)
4. `leased -> dead_letter` (terminal failure or retry limit reached)
5. `queued -> expired` (time exceeded before lease)
6. `failed_retryable -> queued` (backoff elapsed)
7. `queued|failed_retryable -> cancelled` (operator action)

No direct `done/dead_letter/expired/cancelled` back to active states.

## Dedupe and Supersession

### Dedupe Key Formula (v1)

`dedupe_key = sha256(intent_type + source_scope + normalized_target + policy_fingerprint + rule_fingerprint)`

Where:

1. `normalized_target = tweet_id` for seed-based intents.
2. `normalized_target = normalized_query + window_bucket` for `topic_hunt`.

### Supersession Rules

1. Same `dedupe_key` + active existing intent: no-op enqueue (return existing ID).
2. Explicit supersede request: create new intent with new fingerprint and mark prior active intent `cancelled` (audit preserved).
3. Policy/rule change without supersede flag: enqueue blocked to prevent accidental duplicate execution.

## Leasing and Concurrency Contract

### Lease Defaults (v1)

1. `lease_duration_ms = 60000`
2. `lease_renew_interval_ms = 20000`
3. `max_attempts = 8`
4. exponential backoff base `5s`, cap `15m`, jitter `+-20%`

### Correctness Rules

1. Leasing is CAS: update succeeds only if current row is lease-eligible.
2. `ack/fail/requeue` require matching `id + lease_token` in `WHERE`.
3. Expired leases are reclaimable only by lease-expiry path.
4. Stale worker completion with old token must be ignored and logged (`lease_conflict`).

## Lane Scheduling Policy

### Dispatch Strategy (v1)

Weighted round-robin with starvation floor:

1. `urgent-sync = 70`
2. `analysis = 20`
3. `background-topic = 10`

Additional guarantees:

1. If a lane has queued work and was skipped for `N=5` cycles, it gets one forced slot.
2. `urgent-sync` always reserves at least one slot per cycle if non-empty.

### Lane Controls

Per lane:

1. max concurrent leases
2. API call budget/min
3. discovered-post budget/run
4. max runtime per intent

## Budget and Stop Reasons

### Existing + Extended Stop Reasons

1. `limit_reached`
2. `api_call_budget_exhausted`
3. `related_post_budget_exhausted`
4. `mode_cap_reached`
5. `rate_limited_deferred`
6. `intent_expired`
7. `intent_budget_exhausted`
8. `lane_budget_exhausted`
9. `lease_conflict`
10. `retry_limit_reached`

### Budget Evaluation Point

Budget checks happen before every external fetch/search page and before each expansion loop iteration.

## Temporal Topology

### Dispatcher Workflow

1. Fixed workflow ID: `enrich-intent-dispatcher`
2. Responsibilities:
   - poll eligible intents by lane
   - acquire leases
   - dispatch to lane workers
   - publish queue/lane progress query state
3. Uses `continueAsNew` at bounded history thresholds.

### Lane Worker Workflows

1. One workflow type; lane-specific config in input.
2. Processes leased intents in deterministic order:
   - `priority DESC`, `created_at ASC`, `id ASC`
3. Maps intent policy to enrich activity inputs.
4. Uses `ack/fail/requeue` with lease token checks.
5. Uses `continueAsNew` thresholds to cap history growth.

### Dispatcher Pseudocode

```text
loop:
  if paused -> wait
  budgets = load lane budgets
  lane = nextWeightedLaneWithStarvationProtection()
  candidates = leaseEligible(lane, now)
  for intent in candidates (stable order):
    if !laneBudgetAllows(intent): mark stop reason; continue
    if leaseIntentCAS(intent): send to lane worker
  if historyThresholdReached: continueAsNew(carryForwardState)
  sleep(pollInterval)
```

## Rollout Ownership Matrix

| Stage | Ingestion Owner | Execution Owner | Fallback |
| --- | --- | --- | --- |
| Shadow | Legacy + queue shadow ingest | Legacy enrich | Legacy only |
| Limited `sync_minimal` | Queue for cohort; legacy for rest | Queue for cohort | Legacy on error/flag-off |
| `urgent-sync` primary | Queue primary | Queue dispatcher/worker | Legacy kept hot |
| `analysis` enablement | Queue | Queue | Per-lane disable |
| `background-topic` enablement | Queue | Queue | Per-lane disable |

## Architecture Plan

### Phase 0: Contracts + Schema Lock

1. Finalize status model, dedupe formula, lease contract, retry/backoff rules.
2. Land shared intent contract types + deterministic dedupe helpers with tests.
3. Freeze lane config defaults and scheduling policy.

**Exit criteria:**

1. Contract semantics are reviewed, deterministic, and test-locked.
2. Transition, dedupe, and rollout ownership behavior are implementation-ready.

### Phase 1: Intent Ingestion (Non-Disruptive)

1. Land DB migration + intent repo interfaces behind feature flag.
2. Enqueue sync stubs as `sync_minimal` intents behind flag.
3. Add CLI/API for manual `follow_conversation` and `topic_hunt` enqueue.
4. Keep legacy enrich as authoritative execution path.

**Progress (2026-02-22):**

1. P1-01 completed: `enrichment_intents` table + indexes landed in `src/lib/db/schema.ts`.
2. Added schema regression tests in `tests/intent-schema-migration.test.ts`.
3. Active-intent dedupe now has DB-level enforcement via partial unique index.
4. P1-02 completed: queue repo primitives added in `src/lib/db/enrichment-intent-repo.ts`.
5. DB facade wiring added in `src/lib/db/client.ts` for enqueue and dedupe/by-id lookups.
6. DB integration tests added in `tests/db.test.ts` for enqueue/getById/dedupe no-op behavior.
7. P1-03 completed: shared intent payload codecs and runtime validation guards added.
8. Workflow/activity policy normalization paths now use shared sanitizer to reduce divergence.
9. Added codec + activity wrapper tests for queue ingress safety checks.
10. P1-04 completed: enqueue activities added for `sync_minimal`, `follow_conversation`, and `topic_hunt`.
11. Enqueue activities now centralize payload encoding + dedupe-aware persistence path for queue ingestion.
12. P1-05 completed: manual CLI enqueue paths added under `sync intent ...` for all three intent types.
13. CLI path supports validated policy/rules/timing overrides and routes through shared enqueue activities.
14. P1-06 completed: rollout feature flags added to keep legacy enrich authoritative by default.
15. Manual intent enqueue is now gated by ingest flag so queue behavior remains opt-in during migration.
16. P1-07 completed: enqueue validation and dedupe idempotency tests added across DB, shared codecs, activities, and CLI routing.
17. P1 ingestion phase now has passing lint/typecheck/test gates with legacy execution authority preserved.

**Exit criteria:**

1. Dedupe behavior is correct under repeated enqueue attempts.
2. Flag-off mode has zero throughput regression.

### Phase 2: Dispatcher + Lane Workers

1. Add dispatcher workflow and lane worker workflows.
2. Implement CAS leasing and token-checked `ack/fail/requeue`.
3. Add queue/lane status query surfaces.

**Progress (2026-02-22):**

1. P2-01 completed: added `intentDispatcherWorkflow` scaffold with deterministic poll loop and fixed-ID contract.
2. Dispatcher workflow now exposes pause/resume/cancel signals and progress query output for operational control.
3. CLI start path now supports `workflow start intent-dispatcher` and enforces fixed workflow ID `enrich-intent-dispatcher`.
4. Workflow control/status/list surfaces are wired for dispatcher workflow type visibility.
5. Added focused workflow/start-handler tests and validated via lint/typecheck/full test run.
6. P2-02 completed: added `intentLaneWorkerWorkflow` scaffold with deterministic leased-intent ordering (`priority DESC`, `createdAt ASC`, `intentId ASC`).
7. Lane worker now exposes pause/resume/cancel and `enqueueLeasedIntents` signal for leased-batch intake, with progress query telemetry.
8. CLI start path now supports `workflow start intent-lane-worker --lane ...`; workflow control/status/list surfaces are wired for lane worker type.
9. Added dedicated lane-worker workflow/start-handler tests and validated via lint/typecheck/full test run.
10. P2-03 completed: implemented CAS-safe lease lifecycle APIs in queue repo/activity layers (`lease`, `renew`, `ack`, `fail`, `requeue`, `expire`).
11. Lease APIs now enforce token-checked mutation semantics and deterministic lease claim ordering for lane candidates.
12. Added lease-expiry reclaim and intent-expiry terminalization behavior for stale/expired active intents.
13. Added DB + activity regression tests for leasing, token conflicts, retry/dead-letter transitions, and expiry paths; validated via lint/typecheck/full test run.
14. P2-04 completed: dispatcher now applies weighted round-robin lane scheduling with starvation-floor promotion.
15. Dispatcher scheduler uses deterministic tie-break behavior and keeps per-lane skip/selection counters in progress state for verification.
16. Added dispatcher scheduler regression tests for starvation forcing and ready-lane constrained selection; validated via lint/typecheck/full test run.
17. P2-05 completed: dispatcher and lane worker workflows now apply continue-as-new thresholds to bound workflow history growth.
18. Continuation carry-forward now preserves scheduler and lane-worker runtime state (counters, pending work, selection metrics) across workflow runs.
19. Added continuation regression tests for threshold-triggering and carry-forward restoration; validated via lint/typecheck/full test run.

**Exit criteria:**

1. Lease correctness holds under restart/retry/failover tests.
2. No starvation across lanes under mixed load simulation.

### Phase 3: Policy-Aware Execution

1. Map intent policy payloads to existing enrich activity paths.
2. Add bounded topic discovery activity path for `topic_hunt`.
3. Enforce per-intent and per-lane budgets with explicit stop reasons.

**Exit criteria:**

1. Policy payload behavior is honored per intent.
2. Fanout remains bounded for all intent types.

### Phase 4: Progressive Migration

1. Enable queue execution for `urgent-sync` cohort-first.
2. Compare sync freshness/latency against baseline.
3. Expand to `analysis` and `background-topic` only after budget stability.

**Exit criteria:**

1. Sync lane p95 meets baseline or better.
2. Cost and error budgets remain within approved envelopes.

### Phase 5: Legacy Path Wind-Down

1. Keep emergency fallback switch.
2. Decommission legacy enrich trigger path only after sustained stability window.
3. Update docs and runbooks.

**Progress (2026-02-22):**

1. P5-01 completed: emergency fallback switch is tested/documented and acts as a hard queue-execution stop (`legacyEnrichAuthoritative=true`).
2. P5-01a completed: runtime operations simplified for queue mode:
   - Added `workflow start intent-runtime` bootstrap command.
   - `sync` now auto-ensures dispatcher + enabled lane workers in queue execution mode.
   - Dispatcher/lane-worker start commands now use idempotent already-running semantics.

**Exit criteria:**

1. Queue path is primary and stable.
2. Rollback path remains operational and tested.

### Phase 6: Workflow-Attached Policy Profiles (Complete)

Progress update (2026-02-24):

1. `P6-01` completed:
   - Added versioned profile registry contract + JSON schema.
   - Added canonical registry file path: `config/enrichment-policy-profiles.v1.json`.
   - Added contract tests validating path/version/shape invariants.
2. `P6-02` completed:
   - Added config-layer loader + strict validation (`loadEnrichPolicyProfileRegistry`).
   - Added fail-fast error handling for missing file, invalid JSON, and contract violations.
   - Added config-layer regression tests for defaults, path override, and validation failures.
3. `P6-03` completed:
   - Added shared policy precedence resolver:
     - explicit `--policy <name>` > workflow default profile > env-derived fallback.
   - Added `--policy` command plumbing for:
     - `sync` bookmarks command,
     - `workflow start sync`,
     - manual `sync intent ...` enqueue commands.
   - Added routing/precedence regression tests.
4. `P6-04` completed:
   - Persisted policy + rules snapshots into sync workflow input and sync_minimal intent enqueue payloads.
   - Extended enqueue payload snapshots for manual sync/follow intents to include rules where present.
   - Added regression tests verifying sync -> intent snapshot propagation and deterministic enqueue payload shape.
5. `P6-05` completed:
   - Added operator-facing profile docs for sync/manual intent command usage and precedence behavior.
   - Added command-level fallback regressions for env-default behavior when workflow defaults are absent.
   - Added command-level regression for clear unknown `--policy` operator error handling.
6. Runtime behavior scope:
   - registry validation runs at `loadConfig()` startup (fail-fast on misconfiguration),
   - policy precedence + selection is command-wired for sync and manual enqueue paths,
   - policy/rule snapshots are persisted into queued intents for deterministic lane execution.

7. Introduce a versioned policy profile registry file (YAML/JSON) with named enrichment profiles.
8. Add loader + schema validation for policy profiles with deterministic defaults and fail-fast errors.
9. Add CLI/workflow policy selection (`--policy <name>`) for sync and manual intent enqueue paths.
10. Persist resolved policy snapshots into intents so lane execution remains deterministic and replay-safe.
11. Document profile usage and add regression tests for fallback/default behavior.

**Design notes:**

1. Keep global runtime controls in env/config:
   - queue ingest/execution ownership,
   - fallback authority,
   - lane enablement and lane budgets.
2. Keep per-workflow enrich behavior in profile registry:
   - mode and bounded caps,
   - reusable named presets,
   - optional workflow defaults.
3. Resolution precedence:
   - explicit CLI `--policy <name>`,
   - workflow default profile,
   - existing env-derived enrich defaults.
4. Determinism rule:
   - resolve + sanitize profile at enqueue/start time,
   - persist concrete snapshot into workflow/intent input,
   - lane workers execute snapshot only (no mutable config lookup during replay).
5. Backward compatibility:
   - when no profile is selected, existing env-only behavior remains valid.

**Exit criteria:**

1. Workflow-specific enrichment behavior is configurable by profile without codepath forks.
2. Invalid or missing profiles fail fast with clear operator errors.
3. Existing env-only behavior remains backward-compatible when no profile is selected.

## Observability and SLAs

### Required Metrics

1. Queue depth by lane and intent type
2. Lease acquisition success/failure rates
3. Intent latency (`queued -> done`) p50/p95
4. Throughput by lane (`done/min`)
5. Retry and dead-letter rates by error class
6. Budget stop reason counts by lane
7. Fanout distribution by intent type

### Initial SLA Targets (Draft)

1. `urgent-sync`: p95 queue wait < 60s under normal load
2. `analysis`: p95 queue wait < 10m
3. `background-topic`: best-effort, budget-bound, no sync impact

## Failure Handling

### Retryable Errors

1. API rate limit/transient upstream errors
2. network timeout/transient transport failure
3. recoverable lease race

### Terminal Errors

1. invalid policy payload
2. expired intent
3. retry limit reached
4. non-retryable authorization/configuration errors

Terminal paths must set explicit final status and classification code.

## Test Plan (Required)

1. Unit tests for policy/rule fingerprinting and dedupe key generation.
2. Unit tests for lifecycle transitions and invalid transitions rejection.
3. Unit tests for CAS lease semantics and stale-token reject behavior.
4. Workflow tests for deterministic lane ordering and starvation floor.
5. Workflow tests for `continueAsNew` carry-forward correctness.
6. Integration tests for mixed-intent overlap and idempotent writes.
7. Regression tests for legacy path behavior with queue feature disabled.
8. Chaos/restart tests for lease expiry and requeue correctness.

## Rollout Plan

1. Ship schema/repos behind feature flags.
2. Turn on queue shadow metrics only.
3. Enable `sync_minimal` intent ingestion for small cohort.
4. Enable dispatcher for `urgent-sync` only.
5. Expand to `analysis`, then `background-topic` with strict budgets.
6. Evaluate deprecating legacy enrich trigger path.

## Open Questions

1. `topic_hunt` dedupe window bucket size (hour/day) for practical replay behavior.
2. whether manual supersede should auto-cancel active predecessor by default.
3. whether lane caps should be static config or runtime-adjustable via signal.
4. policy profile file format/location (`config/enrich-policies.yaml` vs JSON) and deployment ergonomics.
5. profile lifecycle strategy for future schema versions (`v2+`) and safe migration defaults.

## Initial Implementation Targets

1. `src/lib/db/` (migration + intent repo + lease queries)
2. `src/temporal/shared/` (intent contracts + stop reasons)
3. `src/temporal/activities/` (enqueue/lease/ack/fail/requeue/expire + discovery)
4. `src/temporal/workflows/` (dispatcher + lane workers + status queries)
5. `src/commands/` (intent enqueue + lane status/introspection)
6. `src/lib/config.ts` (`intent.*` lane, scheduling, and budget config)
7. `README.md` (operations and policy usage)
8. `docs/cost-model.md` (lane-level budget envelopes)
9. `src/lib/intents/` (policy profile loader/validator + resolver)
10. `src/commands/sync/` and `src/commands/workflow/start-command/` (`--policy` plumbing)
11. `config/enrich-policies.yaml` (named profile registry; planned)

## References

1. `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`
2. <https://docs.x.com/x-api/fundamentals/conversation-id>
3. <https://docs.x.com/x-api/posts/search/introduction>
4. <https://docs.x.com/x-api/posts/get-quoted-posts>
5. <https://docs.x.com/x-api/fundamentals/rate-limits>

## Notes

This revision makes lease correctness, dedupe semantics, starvation control, and rollout ownership explicit so implementation can proceed with minimal ambiguity and safer migration from the current global-run enrich model.
