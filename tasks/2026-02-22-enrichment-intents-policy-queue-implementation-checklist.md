# Enrichment Intents Queue Implementation Tracker (v0)

**Status:** Active
**Created:** 2026-02-22
**Plan Reference:** `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md`

Use this as the direct execution checklist for implementation. Keep it current as decisions and rollout ownership evolve.

## Phase Board

| Phase | Goal | Status | Start | End | PR |
| --- | --- | --- | --- | --- | --- |
| P0 | Contracts + schema lock | DONE | 2026-02-22 | 2026-02-22 | local |
| P1 | Intent ingestion (non-disruptive) | DONE | 2026-02-22 | 2026-02-22 | local |
| P2 | Dispatcher + lane workers | DONE | 2026-02-22 | 2026-02-22 | local |
| P3 | Policy-aware execution | DONE | 2026-02-22 | 2026-02-22 | local |
| P4 | Progressive migration | IN_PROGRESS | 2026-02-22 | - | local |
| P5 | Legacy wind-down + runbook closeout | IN_PROGRESS | 2026-02-22 | - | local |
| P6 | Workflow-attached policy profiles | IN_PROGRESS | 2026-02-24 | - | local |

## P0: Contracts + Schema Lock

- [x] `P0-01` Finalize intent lifecycle statuses and legal transitions.
  - Output: state machine frozen in plan + types.
  - Evidence: `src/temporal/shared/intent-types.ts`, `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md`
- [x] `P0-02` Finalize dedupe formula (`intent_type + scope + target + policy/rule fingerprint`).
  - Output: deterministic dedupe function and tests.
  - Evidence: `src/lib/intents/dedupe.ts`, `tests/intent-dedupe.test.ts`
- [x] `P0-03` Finalize lease CAS contract (`lease_token`-checked ack/fail/requeue).
  - Output: repo method contract + stale-token behavior.
  - Evidence: `src/temporal/shared/intent-types.ts`, `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md`
- [x] `P0-04` Finalize lane scheduling weights + starvation floor.
  - Output: scheduler policy constants and docs.
  - Evidence: `src/temporal/shared/intent-types.ts`, `tests/intent-policy-queue-contracts.test.ts`
- [x] `P0-05` Finalize stop reasons and failure classification.
  - Output: shared enum + mapping rules.
  - Evidence: `src/temporal/shared/intent-types.ts`, `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md`
- [x] `P0-06` Finalize rollout ownership matrix and fallback behavior.
  - Output: phase gates and rollback criteria.
  - Evidence: `src/temporal/shared/intent-types.ts`, `tests/intent-policy-queue-contracts.test.ts`

### P0 Exit Gate

- [x] P0 complete and reviewed.

### P0 Notes

1. Added executable contract surface for intent lifecycle, lease mutation inputs, rollout matrix, and lane weights:
   - `src/temporal/shared/intent-types.ts`
2. Added deterministic fingerprint + dedupe utility with topic-target normalization:
   - `src/lib/intents/dedupe.ts`
3. Added contract and dedupe regression tests:
   - `tests/intent-policy-queue-contracts.test.ts`
   - `tests/intent-dedupe.test.ts`
4. Exported new shared contracts through:
   - `src/temporal/shared/types.ts`
5. Validation:
   - `pnpm exec vitest run tests/intent-policy-queue-contracts.test.ts tests/intent-dedupe.test.ts`
   - `pnpm test`

## P1: Intent Ingestion (Non-Disruptive)

- [x] `P1-01` Add DB migration for `enrichment_intents` table + indexes.
  - Files: `src/lib/db/` migration files
  - Depends on: `P0-01`, `P0-02`
  - Evidence: `src/lib/db/schema.ts`, `tests/intent-schema-migration.test.ts`
- [x] `P1-02` Implement intent repo methods (`enqueue`, `getById`, dedupe checks).
  - Files: `src/lib/db/` repo files
  - Depends on: `P1-01`
  - Evidence: `src/lib/db/enrichment-intent-repo.ts`, `src/lib/db/client.ts`, `tests/db.test.ts`
- [x] `P1-03` Integrate shared intent contracts into queue payload codecs and validation guards.
  - Files: `src/temporal/shared/`, `src/temporal/workflows/`, `src/temporal/activities/`
  - Depends on: `P0-01`, `P0-05`, `P1-02`
  - Evidence: `src/temporal/shared/intent-payload-codec.ts`, `src/temporal/shared/intent-types.ts`, `src/temporal/workflows/enrich/index.ts`, `src/temporal/activities/store.ts`, `src/temporal/activities/intent.ts`, `tests/intent-payload-codec.test.ts`, `tests/temporal-intent-activities.test.ts`
- [x] `P1-04` Add enqueue activities for `sync_minimal`, `follow_conversation`, `topic_hunt`.
  - Files: `src/temporal/activities/`
  - Depends on: `P1-02`, `P1-03`
  - Evidence: `src/temporal/activities/intent.ts`, `src/temporal/shared/activity-types.ts`, `tests/temporal-intent-activities.test.ts`
- [x] `P1-05` Add CLI/API paths for manual intent enqueue.
  - Files: `src/commands/`
  - Depends on: `P1-04`
  - Evidence: `src/commands/sync/intent.ts`, `src/commands/sync/register.ts`, `tests/sync-intent-command.test.ts`
- [x] `P1-06` Add feature flags to keep legacy enrich authoritative.
  - Files: `src/lib/config.ts`, relevant workflow wiring
  - Depends on: `P1-04`
  - Evidence: `src/lib/config.ts`, `src/types/config.ts`, `src/commands/sync/intent.ts`, `tests/config-enrich-policy.test.ts`
- [x] `P1-07` Add tests for dedupe idempotency and enqueue validation.
  - Depends on: `P1-05`
  - Evidence: `tests/db.test.ts`, `tests/intent-payload-codec.test.ts`, `tests/temporal-intent-activities.test.ts`, `tests/sync-intent-command.test.ts`

### P1 Exit Gate

- [x] Reliable intent creation with dedupe guarantees.
- [x] Feature-flag-off path has zero sync regression.

### P1 Notes (Progress)

1. Added `enrichment_intents` schema to startup migration path via `SCHEMA`:
   - Includes lifecycle/status/type/lane `CHECK` constraints.
   - Includes lane-ready, lease-expiry, expiry, source-scope indexes.
   - Includes partial unique active-intent dedupe index (`idx_intents_dedupe_active`).
2. Added schema migration regression tests:
   - `tests/intent-schema-migration.test.ts`
   - Verifies table/index creation and active-status dedupe uniqueness behavior.
3. Added typed DB row contract for upcoming repo work:
   - `src/types/db.ts` (`DbEnrichmentIntent`)
4. Validation:
   - `pnpm exec vitest run tests/intent-schema-migration.test.ts tests/intent-policy-queue-contracts.test.ts tests/intent-dedupe.test.ts`
   - `pnpm test`
5. Implemented intent repo contract and DB access surface:
   - Added transactional dedupe-aware enqueue (`created` vs existing-active return), `getById`, and `getActiveByDedupeKey`.
   - Added `BookmarksDb` wrappers for queue enqueue and lookups.
   - Added DB integration tests for enqueue/getById/dedupe behavior.
6. Integrated shared intent payload codecs + validation guards:
   - Added shared queue payload encode/decode/validation module.
   - Added runtime enum guard helpers in intent contracts.
   - Wired policy sanitization into enrich workflow and batch activity.
   - Added intent payload activity wrappers for validation/encoding.
   - Added codec and activity-level regression tests.
7. Added concrete enqueue activities per intent type:
   - `enqueueSyncMinimalIntent`, `enqueueFollowConversationIntent`, `enqueueTopicHuntIntent`
   - All use shared codec normalization/fingerprinting/dedupe inputs and durable enqueue via intent repo.
   - Added integration tests covering created vs dedupe-hit behavior.
8. Added manual CLI enqueue paths:
   - `sync intent sync-minimal <tweet-id> --scope <source-scope>`
   - `sync intent follow-conversation <tweet-id> --scope <source-scope>`
   - `sync intent topic-hunt --scope <source-scope> --query <query>`
   - Includes optional lane/source/priority/policy/rules/timing overrides with validation.
   - Added routing tests for all three subcommands.
9. Added rollout feature flags and default-safe gating:
   - Config flags: `INTENT_QUEUE_INGEST_ENABLED`, `INTENT_QUEUE_EXECUTION_ENABLED`, `LEGACY_ENRICH_AUTHORITATIVE`.
   - Defaults preserve legacy authority (`ingest=false`, `execution=false`, `legacy=true`).
   - Manual CLI enqueue now checks `INTENT_QUEUE_INGEST_ENABLED` before enqueueing.
10. Completed enqueue validation/idempotency test coverage:

- DB-level dedupe/idempotent enqueue coverage.
- Payload codec validation coverage (including invalid/missing targets).
- Activity-level enqueue dedupe and invalid-input rejection tests.
- CLI command routing coverage for all manual enqueue entry points.

## P2: Dispatcher + Lane Workers

- [x] `P2-01` Implement dispatcher workflow (`enrich-intent-dispatcher`) with fixed ID.
  - Files: `src/temporal/workflows/`
  - Depends on: `P1-03`
  - Evidence: `src/temporal/workflows/intent-dispatcher.ts`, `src/commands/workflow/start-command/intent-dispatcher.ts`, `tests/temporal-intent-dispatcher-workflow.test.ts`, `tests/workflow-start-intent-dispatcher.test.ts`
- [x] `P2-02` Implement lane worker workflow with deterministic ordering.
  - Files: `src/temporal/workflows/`
  - Depends on: `P2-01`
  - Evidence: `src/temporal/workflows/intent-lane-worker.ts`, `src/commands/workflow/start-command/intent-lane-worker.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`, `tests/workflow-start-intent-lane-worker.test.ts`
- [x] `P2-03` Implement lease APIs (`lease`, `renew`, `ack`, `fail`, `requeue`, `expire`).
  - Files: `src/lib/db/`, `src/temporal/activities/`
  - Depends on: `P0-03`, `P1-02`
  - Evidence: `src/lib/db/enrichment-intent-repo.ts`, `src/lib/db/client.ts`, `src/temporal/activities/intent.ts`, `src/temporal/shared/activity-types.ts`, `tests/db.test.ts`, `tests/temporal-intent-activities.test.ts`
- [x] `P2-04` Add weighted round-robin + starvation protection in dispatcher.
  - Depends on: `P0-04`, `P2-01`
  - Evidence: `src/temporal/workflows/intent-dispatcher.ts`, `src/temporal/shared/intent-types.ts`, `tests/temporal-intent-dispatcher-workflow.test.ts`
- [x] `P2-05` Add `continueAsNew` thresholds for dispatcher and workers.
  - Depends on: `P2-01`, `P2-02`
  - Evidence: `src/temporal/workflows/intent-dispatcher.ts`, `src/temporal/workflows/intent-lane-worker.ts`, `src/temporal/shared/intent-types.ts`, `tests/temporal-intent-dispatcher-workflow.test.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`
- [x] `P2-06` Add status query surfaces (queue depth, lane health, lease conflicts).
  - Files: workflows + commands
  - Depends on: `P2-01`, `P2-02`
  - Evidence: `src/lib/db/enrichment-intent-repo.ts`, `src/lib/db/client.ts`, `src/temporal/shared/activity-types.ts`, `src/temporal/shared/intent-types.ts`, `src/temporal/activities/intent.ts`, `src/temporal/workflows/intent-dispatcher.ts`, `src/commands/workflow/status-command/progress.ts`, `tests/temporal-intent-activities.test.ts`, `tests/temporal-intent-dispatcher-workflow.test.ts`
- [x] `P2-07` Add tests for lease correctness, determinism, and starvation floor.
  - Depends on: `P2-03`, `P2-04`
  - Evidence: `tests/db.test.ts`, `tests/temporal-intent-dispatcher-workflow.test.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`

### P2 Exit Gate

- [x] Lease/retry behavior correct under restart/failover tests.
- [x] No lane starvation under mixed load simulation.

### P2 Notes (Progress)

1. Completed `P2-01` dispatcher scaffold with deterministic loop semantics:
   - Added `intentDispatcherWorkflow` with pause/resume/cancel signals and progress query.
   - Added fixed workflow ID contract constant: `enrich-intent-dispatcher`.

2. Wired dispatcher into Temporal + CLI surfaces:
   - Workflow exports/index registration.
   - `workflow start intent-dispatcher` command with enforced fixed workflow ID.
   - Workflow control/status/list support for dispatcher workflow type.

3. Added focused regression coverage:
   - Workflow behavior tests (cycle execution, cancellation path, progress query state).
   - CLI start handler tests validating fixed-ID enforcement and start payload wiring.

4. Validation:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

5. Completed `P2-02` lane worker deterministic-order scaffold:
   - Added `intentLaneWorkerWorkflow` for lane-scoped processing with deterministic sort contract:
     - `priority DESC`, `createdAt ASC`, `intentId ASC`, `leaseToken ASC`.
   - Added lane worker signal/query surface and leased-intent ingestion signal.

6. Wired lane worker into operational surfaces:
   - Added `workflow start intent-lane-worker --lane ...`.
   - Added workflow control/status/list support for `intentLaneWorkerWorkflow`.

7. Added focused regression tests:
   - `tests/temporal-intent-lane-worker-workflow.test.ts`
   - `tests/workflow-start-intent-lane-worker.test.ts`

8. Validation:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

9. Completed `P2-03` lease lifecycle APIs with CAS semantics:
   - Added repo methods for `lease`, `renew`, `ack`, `fail`, `requeue`, and `expire`.
   - Added token-checked mutation guards for `ack/fail/requeue/renew`.
   - Added lease-expiry requeue and intent-expiry terminalization paths.

10. Wired DB and activity interfaces for workflow consumption:
    - Added `BookmarksDb` wrappers for all lease lifecycle operations.
    - Added Temporal activity contracts and activity implementations for lease APIs.

11. Added regression coverage for lease correctness:
    - DB-level leasing, token-CAS, fail/requeue, and expire behavior.
    - Activity-level lease mutation + expiry behavior.

12. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

13. Completed `P2-04` dispatcher scheduling policy implementation:
    - Added weighted round-robin lane selection from `INTENT_LANE_WEIGHTS`.
    - Added starvation-floor forcing using `INTENT_STARVATION_FLOOR_CYCLES` with deterministic tie-breaks.
    - Added dispatcher signal to control ready lane set for deterministic scaffolding/tests (`setReadyLanes`).

14. Extended dispatcher observability state:
    - Progress now includes `lastSelectedLane`, per-lane selection counters, per-lane skip-cycle counters, and current ready-lane set.
    - Result now carries lane selection counters for run-level diagnostics.

15. Added scheduler regression coverage:
    - Dispatcher workflow tests now validate starvation-floor forcing and ready-lane constrained selection behavior.

16. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

17. Completed `P2-05` history rollover support with `continueAsNew`:
    - Added threshold-based continue checks (history length, history size, SDK suggestion) for dispatcher and lane workers.
    - Added continuation carry-forward state for counters/scheduler/pending work preservation across workflow runs.

18. Added continuation regression coverage:
    - Dispatcher tests now validate threshold-triggered continuation and carry-forward restoration behavior.
    - Lane worker tests now validate threshold-triggered continuation and carry-forward restoration behavior.

19. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

20. Completed `P2-06` queue-status query surfaces:
    - Added durable queue status snapshot query in intent repo/DB facade (lane health, totals, lease-conflict counters).
    - Added `getIntentQueueStatus` Temporal intent activity contract + implementation.
    - Dispatcher now refreshes and publishes queue status through `progress` query state each cycle.
    - Workflow status renderer now shows queue totals, per-lane health, overdue leases, and lease conflict metrics.

21. Added regression coverage for status surfaces:
    - `tests/temporal-intent-activities.test.ts` now validates queue status snapshot semantics.
    - `tests/temporal-intent-dispatcher-workflow.test.ts` now validates queue status propagation to progress query output.

22. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

23. Completed `P2-07` targeted reliability test expansion:
    - Added DB failover regression for lease-expiry reclaim and stale-token rejection after re-lease.
    - Added dispatcher deterministic-sequence replay test under equivalent mixed-load ready-lane inputs.
    - Added long-run mixed-load starvation simulation test validating bounded skip growth and lane service coverage.

24. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

## P3: Policy-Aware Execution

- [x] `P3-01` Map intent policy payload to existing enrich execution inputs.
  - Files: `src/temporal/activities/store.ts`, workflow adapters
  - Depends on: `P2-02`
  - Evidence: `src/temporal/activities/store.ts`, `src/temporal/workflows/intent-policy-adapter.ts`, `src/temporal/workflows/intent-lane-worker.ts`, `src/temporal/shared/activity-types.ts`, `src/temporal/shared/intent-types.ts`, `src/temporal/activities/intent.ts`, `tests/intent-policy-adapter.test.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`, `tests/temporal-activities.test.ts`, `tests/temporal-intent-activities.test.ts`
- [x] `P3-02` Add bounded `topic_hunt` discovery path (query + page/time limits).
  - Files: `src/temporal/activities/`, API client/sources
  - Depends on: `P1-03`
  - Evidence: `src/temporal/activities/fetch.ts`, `src/temporal/activities/store.ts`, `src/sources/types.ts`, `src/sources/x-api.ts`, `src/lib/api/client/endpoints.ts`, `src/lib/api/x-api-client.ts`, `src/temporal/shared/intent-payload-codec.ts`, `src/temporal/shared/activity-types.ts`, `src/temporal/shared/intent-types.ts`, `src/temporal/activities/intent.ts`, `src/temporal/workflows/intent-lane-worker.ts`, `tests/temporal-fetch-activities.test.ts`, `tests/temporal-activities.test.ts`, `tests/temporal-intent-activities.test.ts`, `tests/intent-payload-codec.test.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`
- [x] `P3-03` Enforce per-intent and per-lane budget checks pre-step.
  - Depends on: `P0-05`, `P2-04`
  - Evidence: `src/temporal/workflows/intent-lane-worker.ts`, `src/temporal/shared/intent-types.ts`, `src/temporal/workflows/intent-policy-adapter.ts`, `src/temporal/activities/store.ts`, `tests/temporal-intent-lane-worker-workflow.test.ts`, `tests/intent-policy-adapter.test.ts`, `tests/temporal-activities.test.ts`
- [x] `P3-04` Ensure discovered context persists as tweet rows only.
  - Depends on: `P3-01`, `P3-02`
  - Evidence: `src/temporal/activities/store.ts`, `tests/temporal-activities.test.ts`
- [x] `P3-05` Add tests for bounded fanout and overlap idempotency.
  - Depends on: `P3-02`, `P3-03`
  - Evidence: `tests/temporal-activities.test.ts`

### P3 Exit Gate

- [x] Per-intent policy execution is honored and observable.
- [x] Fanout remains bounded for all intent types.

### P3 Notes (Progress)

1. Completed `P3-01` intent-policy mapping onto existing enrich execution paths:
    - Added workflow adapter mapping from leased intent metadata to `enrichRecordsBatch` inputs.
    - Extended lane worker execution to route metadata-backed intents through intent-aware enrich activity inputs.
    - Added store-side `executeIntentEnrichment` bridge to map intent policy payloads to existing batch enrich behavior.

2. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

3. Completed `P3-02` bounded `topic_hunt` discovery path:
    - Added topic search page fetch activity path (`fetchTopicTweetsPage`) with rate-limit/error metadata.
    - Added X API/source support for generic recent-search queries used by topic discovery.
    - Extended intent payload encoding + lease metadata flow so `topic_hunt` retains executable query context.
    - Added bounded topic discovery execution in store activity with explicit page caps, discovery-age filtering, and API-call budget application.

4. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

5. Completed `P3-03` pre-step budget enforcement for intent and lane execution:
    - Added lane execution budget contracts/defaults and lane worker pre-step guards with explicit budget stop-reason tracking (`intent_budget_exhausted`, `lane_budget_exhausted`).
    - Lane worker now constrains per-intent policy by remaining lane budget before each execution step and defers unprocessed intents when lane budget is exhausted.
    - Added `maxRelatedPostsPerRun` cap propagation into seed-driven mode fanout caps in both workflow adapter and store-side intent execution mapping.

6. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

7. Completed `P3-04` discovered-context persistence guardrails (tweet rows only):
    - Locked invariants with regression assertions that discovered context from origin/conversation/quotes/topic-hunt enrich paths does not create bookmark rows.
    - Verified seed bookmark rows remain unchanged while discovered context is persisted as tweet rows.

8. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

9. Completed `P3-05` bounded fanout + overlap idempotency regression coverage:
    - Added topic-hunt tests that verify bounded discovery fanout under `maxRelatedPostsPerRun` with duplicate overlap across pages.
    - Added repeated topic-hunt overlap run coverage to verify discovered tweet upserts remain idempotent.

10. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

## P4: Progressive Migration

- [x] `P4-01` Enable shadow metrics with legacy execution owner.
  - Depends on: `P2-06`
  - Evidence: `src/temporal/workflows/sync/index.ts`, `src/temporal/workflows/sync/page-runner.ts`, `src/temporal/workflows/sync/runtime.ts`, `src/temporal/workflows/sync/runtime-state.ts`, `src/temporal/workflows/sync/handlers.ts`, `src/temporal/shared/sync-types.ts`, `src/commands/workflow/start-command/sync.ts`, `src/commands/workflow/status-command/progress.ts`, `tests/temporal-sync-workflow.test.ts`, `tests/sync-command-routing.test.ts`
- [x] `P4-02` Enable `sync_minimal` ingestion for limited cohort.
  - Depends on: `P1` exit, `P4-01`
  - Evidence: `src/types/config.ts`, `src/lib/config.ts`, `src/temporal/shared/sync-types.ts`, `src/temporal/workflows/sync/index.ts`, `src/temporal/workflows/sync/page-runner.ts`, `src/temporal/workflows/sync/runtime.ts`, `src/temporal/workflows/sync/runtime-state.ts`, `src/temporal/workflows/sync/handlers.ts`, `src/commands/sync/bookmarks/temporal.ts`, `src/commands/workflow/start-command/sync.ts`, `src/commands/workflow/status-command/progress.ts`, `tests/config-enrich-policy.test.ts`, `tests/temporal-sync-workflow.test.ts`, `tests/sync-command-routing.test.ts`, `tests/sync-intent-command.test.ts`
- [x] `P4-03` Enable queue execution for `urgent-sync` lane only.
  - Depends on: `P2` exit, `P4-02`
  - Evidence: `src/temporal/workflows/sync/index.ts`, `src/temporal/workflows/sync/page-runner.ts`, `src/temporal/workflows/sync/runtime.ts`, `src/temporal/workflows/sync/runtime-state.ts`, `src/temporal/workflows/sync/handlers.ts`, `src/temporal/shared/sync-types.ts`, `src/commands/workflow/status-command/progress.ts`, `tests/temporal-sync-workflow.test.ts`
- [x] `P4-04` Enable `analysis` lane with strict budgets.
  - Depends on: `P3` exit, `P4-03`
  - Evidence: `src/types/config.ts`, `src/lib/config.ts`, `.env.example`, `src/lib/intents/rollout.ts`, `src/commands/workflow/start-command/intent-dispatcher.ts`, `src/commands/workflow/start-command/intent-lane-worker.ts`, `tests/config-enrich-policy.test.ts`, `tests/intent-queue-rollout.test.ts`, `tests/workflow-start-intent-dispatcher.test.ts`, `tests/workflow-start-intent-lane-worker.test.ts`
- [x] `P4-05` Enable `background-topic` lane with strict budgets.
  - Depends on: `P3` exit, `P4-04`
  - Evidence: `src/types/config.ts`, `src/lib/config.ts`, `.env.example`, `src/lib/intents/rollout.ts`, `tests/config-enrich-policy.test.ts`, `tests/intent-queue-rollout.test.ts`, `tests/workflow-start-intent-dispatcher.test.ts`, `tests/workflow-start-intent-lane-worker.test.ts`
- [x] `P4-06` Validate SLA/cost gates and rollback readiness per stage.
  - Depends on: `P4-03`, `P4-04`, `P4-05`
  - Evidence: `src/lib/intents/rollout-gates.ts`, `src/commands/workflow/rollout-gates.ts`, `src/commands/workflow/register.ts`, `tests/intent-rollout-gates.test.ts`

### P4 Exit Gate

- [ ] Sync freshness/latency meets or beats baseline.
- [ ] Cost and error rates remain within approved envelopes.

### P4 Notes (Progress)

1. Completed `P4-01` shadow metrics with legacy execution ownership:
    - Sync workflow now supports shadow-mode queue ingestion for `sync_minimal` intents when ingest is enabled while queue execution remains disabled and legacy enrich stays authoritative.
    - Added sync progress/status telemetry for shadow intent ingestion counters (attempted, enqueued, deduped, failed).
    - Added deterministic shadow source-scope mapping and per-page stub-id extraction for bounded ingest behavior.

2. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

3. Completed `P4-02` limited-cohort `sync_minimal` ingestion controls:
    - Added rollout config support for `INTENT_QUEUE_SYNC_MINIMAL_INGEST_COHORT_PERCENT` with [0,100] clamping and default-safe value `100`.
    - Shadow sync ingest now applies deterministic per-tweet cohort bucketing so only the configured cohort is enqueued.
    - Extended shadow ingest telemetry to include `cohortPercent` and `cohortSkipped` counters for rollout monitoring.

4. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

5. Completed `P4-03` urgent-sync queue execution migration with guarded legacy fallback:
    - Sync workflow now enables `sync_minimal` enqueue during queue-execution mode (`ingest=true`, `execution=true`, `legacy=false`) and suppresses legacy enrich triggers when queue ingest fully handles the page.
    - Added per-page legacy fallback behavior when queue ingest is partial or fails (cohort-skipped or enqueue exceptions), so legacy enrich remains hot as a safety path.
    - Added progress/status telemetry for execution migration state: `intentQueueExecutionEnabled`, `legacyEnrichSuppressed`, `legacyEnrichFallbacks`.

6. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

7. Completed `P4-04` analysis-lane enablement controls with strict budget wiring:
    - Added rollout config flags to enable analysis/background-topic execution lanes independently while preserving urgent-sync-first execution as default.
    - Added strict analysis lane budget config (`api calls/cycle`, `discovered posts/cycle`) with validated defaults and env overrides.
    - Dispatcher start now seeds ready lanes from rollout config; lane worker start now injects analysis lane budget override deterministically.

8. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

9. Completed `P4-05` background-topic lane enablement controls with strict budget wiring:
    - Added explicit background-topic lane budget config (`api calls/cycle`, `discovered posts/cycle`) with validated defaults and env overrides.
    - Extended lane budget override resolver so both analysis and background-topic lanes receive deterministic budget injection only when their rollout flag is enabled.
    - Added dispatcher/lane-worker start-path test coverage for background-topic lane readiness and strict budget override propagation.

10. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

11. Completed `P4-06` rollout gate validation and rollback-readiness command:
    - Added deterministic rollout gate evaluator for SLA/cost proxy checks and stage inference (queue wait by lane, overdue leases, lease conflicts, retryable envelope).
    - Added rollback-readiness validation via sync telemetry (`intentQueueExecutionEnabled`, `legacyEnrichFallbacks`) with optional strict fallback-exercised requirement.
    - Added new CLI entrypoint: `workflow rollout-gates` for pass/fail stage validation against dispatcher queue telemetry.

12. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

## P5: Legacy Path Wind-Down + Closeout

- [x] `P5-01` Keep emergency fallback switch tested and documented.
  - Depends on: `P4` exit
  - Evidence: `src/lib/intents/rollout.ts`, `tests/intent-queue-rollout.test.ts`, `tests/workflow-start-intent-dispatcher.test.ts`, `tests/workflow-start-intent-lane-worker.test.ts`, `README.md`, `.env.example`
- [x] `P5-01a` Simplify intent runtime operator startup/operations.
  - Depends on: `P4-03`, `P4-04`, `P4-05`
  - Evidence: `src/commands/workflow/intent-runtime.ts`, `src/commands/workflow/start-command/intent-runtime.ts`, `src/commands/sync/bookmarks/temporal.ts`, `src/commands/workflow/start-command/intent-dispatcher.ts`, `src/commands/workflow/start-command/intent-lane-worker.ts`, `src/temporal/shared/intent-types.ts`, `tests/intent-runtime-workflows.test.ts`, `tests/workflow-start-intent-runtime.test.ts`, `tests/sync-command-routing.test.ts`, `tests/workflow-start-intent-dispatcher.test.ts`, `tests/workflow-start-intent-lane-worker.test.ts`, `README.md`
- [ ] `P5-02` Decommission legacy enrich trigger path after stability window.
  - Depends on: `P5-01`
  - Evidence:
- [ ] `P5-03` Finalize README/runbook updates.
  - Files: `README.md`, ops docs
  - Depends on: `P5-02`
  - Evidence:
- [ ] `P5-04` Record final metrics and post-migration review.
  - Depends on: `P5-02`
  - Evidence:

### P5 Exit Gate

- [ ] Queue path primary + stable.
- [ ] Rollback path verified.
- [ ] Documentation reflects shipped architecture.

### P5 Notes (Progress)

1. Completed `P5-01` emergency fallback switch hardening + runbook documentation:
    - Rollout helper resolution now treats `legacyEnrichAuthoritative=true` as a hard queue-execution stop (`seedReadyLanes=[]`, no lane budget overrides).
    - Added regression coverage for emergency fallback behavior in rollout helper and workflow start-command test suites.
    - Documented emergency fallback drill and verification commands in `README.md`, and added explicit fallback guidance in `.env.example`.

2. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

3. Added operator UX/runtime-bootstrap improvements for intent execution mode:
    - Added idempotent runtime ensure helper that starts dispatcher + per-lane workers with stable IDs and tolerates already-running workflows.
    - Sync temporal path now auto-ensures intent runtime when queue execution lanes are enabled, reducing manual multi-process startup burden.
    - Added manual bootstrap entrypoint `workflow start intent-runtime` and README guidance for explicit runtime bring-up.

4. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

5. Hardened manual runtime control command ergonomics:
    - `workflow start intent-lane-worker` now defaults to stable per-lane workflow IDs (`enrich-intent-lane-worker-<lane>`).
    - `workflow start intent-dispatcher` and `workflow start intent-lane-worker` now treat already-started errors as non-fatal and report "already running".

6. Validation:
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

## P6: Workflow-Attached Policy Profiles

- [x] `P6-01` Define versioned policy profile registry contract and file format.
  - Output: profile schema + canonical file location.
  - Depends on: `P3` exit
  - Evidence: `src/lib/intents/policy-profile-registry-contract.ts`, `config/enrichment-policy-profiles.v1.json`, `tests/enrichment-policy-profile-registry-contract.test.ts`
- [x] `P6-02` Implement profile loader + schema validation with fail-fast errors.
  - Output: deterministic profile parse/validation path in config layer.
  - Depends on: `P6-01`
  - Evidence: `src/lib/config.ts`, `tests/config-policy-profile-registry.test.ts`
- [x] `P6-03` Add profile resolution precedence and command plumbing (`--policy <name>`).
  - Output: explicit selection + workflow defaults + env fallback order.
  - Depends on: `P6-02`
  - Evidence: `src/lib/intents/policy-profile-selection.ts`, `src/commands/sync/bookmarks/{register.ts,types.ts,options.ts,temporal.ts}`, `src/commands/sync/intent.ts`, `src/commands/workflow/start-command/{register.ts,sync.ts,types.ts}`, `tests/policy-profile-selection.test.ts`, `tests/sync-command-routing.test.ts`, `tests/sync-intent-command.test.ts`
- [x] `P6-04` Persist resolved policy snapshots into workflow/intent payloads.
  - Output: lane execution remains snapshot-driven and deterministic.
  - Depends on: `P6-03`
  - Evidence: `src/temporal/shared/{sync-types.ts,activity-types.ts}`, `src/temporal/workflows/sync/page-runner.ts`, `src/temporal/activities/intent.ts`, `src/commands/sync/bookmarks/temporal.ts`, `src/commands/workflow/start-command/sync.ts`, `src/commands/sync/intent.ts`, `tests/temporal-sync-workflow.test.ts`, `tests/sync-command-routing.test.ts`, `tests/sync-intent-command.test.ts`
- [x] `P6-05` Add docs + regression coverage for profile behavior and backward compatibility.
  - Output: operator docs and tests for valid/invalid profiles and fallback behavior.
  - Depends on: `P6-04`
  - Evidence: `README.md`, `.env.example`, `docs/operations/enrichment-runtime-cheatsheet.md`, `tests/sync-command-routing.test.ts`, `tests/sync-intent-command.test.ts`

### P6 Exit Gate

- [x] Workflow-specific enrich behavior is configurable via named profiles.
- [x] Invalid/missing profiles fail fast with clear operator errors.
- [x] Env-only behavior remains backward-compatible when no profile is selected.

### P6 Notes (Progress)

1. Completed `P6-01` contract-first profile registry definition with no runtime behavior change:
   - Added typed version contract, canonical registry location constant, JSON Schema, and runtime shape guards.
   - Canonical file path is locked at `config/enrichment-policy-profiles.v1.json`.

2. Added initial canonical registry document (v1 JSON format):
   - Includes baseline `atomic-default` profile and explicit workflow/intent default mapping examples.

3. Added contract regression coverage:
   - `tests/enrichment-policy-profile-registry-contract.test.ts` validates version/path locks, canonical-file validity, and invalid-shape rejection.

4. Validation:
   - `pnpm exec vitest run tests/enrichment-policy-profile-registry-contract.test.ts`
   - `pnpm run typecheck`
   - `pnpm run lint`

5. Completed `P6-02` loader + validation integration in config layer:
   - Added `loadEnrichPolicyProfileRegistry()` with deterministic path resolution:
     - default canonical path: `config/enrichment-policy-profiles.v1.json`
     - optional override: `ENRICH_POLICY_PROFILE_REGISTRY_PATH`
   - Added strict fail-fast errors for:
     - missing file,
     - invalid JSON,
     - schema/contract violations.
   - Wired `loadConfig()` startup to validate registry eagerly.

6. Added config-layer regression coverage:
   - `tests/config-policy-profile-registry.test.ts`
   - Covers default load, env-path override, and all fail-fast error classes.

7. Validation:
   - `pnpm exec vitest run tests/config-policy-profile-registry.test.ts tests/enrichment-policy-profile-registry-contract.test.ts`
   - `pnpm run typecheck`
   - `pnpm run lint`

8. Completed `P6-03` precedence + CLI plumbing:
   - Added shared resolver for deterministic precedence:
     - explicit `--policy <name>`,
     - workflow default profile,
     - env-derived fallback policy.
   - Added `--policy <name>` support to:
     - `sync` bookmarks command,
     - `workflow start sync`,
     - `sync intent ...` manual enqueue subcommands.
   - Preserved existing `--policy-json` path for manual intent enqueue and enforced mutual exclusivity with `--policy`.

9. Added regression coverage for precedence and command routing:
   - `tests/policy-profile-selection.test.ts` (explicit/workflow-default/env fallback + invalid profile errors)
   - `tests/sync-command-routing.test.ts` (workflow-default and explicit profile selection for sync)
   - `tests/sync-intent-command.test.ts` (workflow-default and explicit profile selection for intent enqueue)

10. Validation:

    - `pnpm exec vitest run tests/policy-profile-selection.test.ts tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts`
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

11. Completed `P6-04` snapshot persistence across workflow/intent boundaries:

    - Sync workflow inputs now carry both policy and rules snapshots:
      - `enrichPolicy`,
      - `enrichRules`.
    - Sync page processing now enqueues `sync_minimal` intents using workflow snapshots (policy + rules) instead of a hardcoded inline policy.
    - Manual intent enqueue activities now persist rules snapshots for:
      - `sync_minimal`,
      - `follow_conversation`,
      - `topic_hunt`.

12. Determinism behavior:

    - Lane workers execute leased intent payload snapshots (`policy_json`/`rules_json`) only.
    - No runtime mutable config lookup is required at intent execution time.

13. Validation:

    - `pnpm exec vitest run tests/temporal-sync-workflow.test.ts tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts tests/policy-profile-selection.test.ts`
    - `pnpm run lint`
    - `pnpm run typecheck`
    - `pnpm test`

14. Completed `P6-05` docs + regression coverage:

    - Added operator docs for profile registry path, policy precedence, and command examples:
      - `README.md`
      - `.env.example`
      - `docs/operations/enrichment-runtime-cheatsheet.md`
    - Added command-level regressions for:
      - sync fallback to env-derived policy when no workflow default profile exists,
      - manual follow-conversation fallback to env-derived policy when no intent workflow default exists,
      - clear unknown `--policy` failure behavior for sync command path.

15. Validation:

    - `pnpm exec vitest run tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts`
    - `pnpm run typecheck`
    - `pnpm run lint`

## Decision Log

| Date | Decision | Why | Link |
| --- | --- | --- | --- |
| 2026-02-22 | Treat P0 as contracts/test lock only; move schema/repo delivery to P1 | Avoids phase overlap and keeps migration risk out of contract locking slice | `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md` |

## Change Log

| Date | Update | Author |
| --- | --- | --- |
| 2026-02-22 | Created tracker v0 | Codex |
| 2026-02-22 | Completed P0 contracts + schema lock checklist items with code + tests | Codex |
| 2026-02-22 | Aligned Phase boundaries: kept contracts in P0, moved schema/repo work to P1 scope | Codex |
| 2026-02-22 | Completed P1-01 by adding `enrichment_intents` schema/index migration path + schema regression tests | Codex |
| 2026-02-22 | Completed P1-02 by adding intent repo enqueue/getById/dedupe checks with DB wiring + tests | Codex |
| 2026-02-22 | Completed P1-03 by adding shared intent payload codecs/guards and integrating into workflow/activity policy normalization paths | Codex |
| 2026-02-22 | Completed P1-04 by adding per-intent enqueue activities with durable dedupe-aware persistence | Codex |
| 2026-02-22 | Completed P1-05 by adding manual CLI intent enqueue paths with validated overrides and routing tests | Codex |
| 2026-02-22 | Completed P1-06 by adding intent queue rollout flags with default-safe legacy authority and CLI ingest gating | Codex |
| 2026-02-22 | Completed P1-07 by adding dedupe idempotency and enqueue validation test coverage across DB, codecs, activities, and CLI routing | Codex |
| 2026-02-22 | Completed P2-01 by adding a fixed-ID intent dispatcher workflow scaffold with CLI start/control/status/list wiring and dedicated tests | Codex |
| 2026-02-22 | Completed P2-02 by adding deterministic lane worker workflow scaffolding with lane CLI start path, control/status/list wiring, and regression tests | Codex |
| 2026-02-22 | Completed P2-03 by implementing CAS-safe lease lifecycle APIs (lease/renew/ack/fail/requeue/expire) with DB+activity wiring and regression tests | Codex |
| 2026-02-22 | Completed P2-04 by implementing weighted round-robin + starvation-floor dispatcher scheduling with deterministic scheduler tests | Codex |
| 2026-02-22 | Completed P2-05 by adding continueAsNew thresholds and carry-forward state for dispatcher/lane-worker workflows with continuation tests | Codex |
| 2026-02-22 | Completed P2-06 by adding queue status query surfaces (queue depth/lane health/lease conflicts) across DB, activities, dispatcher progress query, CLI rendering, and tests | Codex |
| 2026-02-22 | Completed P2-07 by expanding lease/failover correctness and mixed-load deterministic starvation-floor test coverage | Codex |
| 2026-02-22 | Completed P3-01 by mapping intent policy payloads into existing enrich execution inputs via workflow adapter and store bridge paths | Codex |
| 2026-02-22 | Completed P3-02 by adding bounded topic_hunt discovery (query + page/time limits) across source/fetch/store execution paths with regression tests | Codex |
| 2026-02-22 | Completed P3-03 by enforcing pre-step per-intent/per-lane budgets in lane execution with explicit budget stop-reason tracking and fanout-cap propagation | Codex |
| 2026-02-22 | Completed P3-04 by locking discovered-context persistence invariants with tweet-row-only regression coverage across enrich discovery modes | Codex |
| 2026-02-22 | Completed P3-05 by adding bounded fanout and overlap-idempotency tests for topic-hunt discovery across page overlap and repeated runs | Codex |
| 2026-02-22 | Completed P4-01 by enabling sync shadow intent-ingest metrics while preserving legacy enrich as execution owner | Codex |
| 2026-02-22 | Completed P4-02 by adding deterministic limited-cohort sync-minimal ingest controls and telemetry for shadow rollout | Codex |
| 2026-02-22 | Completed P4-03 by enabling urgent-sync queue execution with per-page legacy enrich suppression/fallback telemetry and regression tests | Codex |
| 2026-02-22 | Completed P4-04 by adding analysis/background lane rollout controls with strict analysis lane budget wiring in dispatcher/worker start paths | Codex |
| 2026-02-22 | Completed P4-05 by adding strict background-topic lane budget controls and rollout-aware dispatcher/worker wiring with regression coverage | Codex |
| 2026-02-22 | Completed P4-06 by adding rollout gate validator command and deterministic SLA/cost/rollback-readiness checks using dispatcher + sync telemetry | Codex |
| 2026-02-22 | Completed P5-01 by hardening emergency fallback switch semantics across rollout helpers and documenting rollback drill/verification steps | Codex |
| 2026-02-22 | Added intent-runtime bootstrap helper/command and sync auto-ensure behavior to reduce queue-mode operational startup overhead | Codex |
| 2026-02-22 | Added stable per-lane lane-worker IDs and idempotent already-running handling for dispatcher/lane start commands | Codex |
| 2026-02-22 | Marked P5-01a complete for intent-runtime operator simplification (auto-ensure, bootstrap command, idempotent runtime starts) | Codex |
| 2026-02-22 | Added planned P6 tracker section for workflow-attached enrichment policy profile implementation | Codex |
| 2026-02-24 | Completed P6-01 by defining the versioned policy profile registry contract, canonical file path, and schema lock tests | Codex |
| 2026-02-24 | Completed P6-02 by adding config-layer policy registry loading/validation with fail-fast errors and regression tests | Codex |
| 2026-02-24 | Completed P6-03 by adding deterministic policy precedence resolution and `--policy` plumbing across sync and manual intent enqueue commands | Codex |
| 2026-02-24 | Completed P6-04 by persisting resolved policy/rules snapshots into workflow inputs and enqueued intent payloads for deterministic lane execution | Codex |
| 2026-02-24 | Completed P6-05 by documenting profile registry/precedence usage and adding command-level fallback + unknown-policy regression coverage | Codex |
