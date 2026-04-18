# Task: Enrichment Intents Queue and Policy Lanes (Narrative Writeup)

**Status:** Active (P0 complete)
**Created:** 2026-02-22
**Plan Reference:** `.project/plans/2026-02-22-enrichment-intents-policy-queue-plan.md`

## Context

Enrichment today is optimized for a single run policy and global stub selection. That is efficient for lightweight sync hydration, but it does not provide a clean model for mixed workloads with different urgency and budget needs. We now need to support three distinct intents in one system:

1. fast sync hydration,
2. deeper conversation-follow behavior,
3. topic/keyword discovery that is independent of `conversation_id`.

Without intent isolation, high-cost discovery can interfere with sync freshness and make operational control harder.

## Intention

This task introduces a durable intent queue and lane-based execution model so enrichment can run as policy-isolated workloads with explicit budgets, scheduling, and observability. The design goal is to expand capability without regressing deterministic workflow behavior or safety guarantees.

## Expected Outcome

This initiative is successful when:

1. sync enrichment remains low-latency under normal load,
2. deeper analysis workloads can run without starving sync,
3. queue lifecycle and lease semantics are deterministic under retries/restarts,
4. rollout can progress gradually with clear fallback ownership.

## Scope

In scope:

- durable intent queue schema and APIs,
- CAS-style leasing and retry semantics,
- dispatcher + lane worker Temporal topology,
- policy-aware execution path mapping,
- lane-level budgets/stop reasons,
- staged migration from legacy enrich flow.

Out of scope:

- unbounded crawl/search behavior,
- one-shot migration that removes legacy enrich immediately,
- discovered-context bookmark creation.

## Narrative Design

### Phase 0: Contracts and Schema Lock

The first step is to remove ambiguity. We lock:

- state machine (`queued`, `leased`, `done`, `failed_retryable`, `dead_letter`, `expired`, `cancelled`),
- dedupe formula and supersession behavior,
- lease CAS contract (`id + lease_token` correctness),
- lane scheduling policy and starvation guard,
- stop reasons and failure taxonomy.

This phase is about predictability, not feature surface.

#### Phase 0 completion notes (2026-02-22)

Implemented and validated:

1. Shared intent contract module covering lifecycle, lease mutation inputs, stop reason extensions, lane weights, starvation floor, and rollout matrix:
   - `src/temporal/shared/intent-types.ts`
2. Deterministic dedupe/fingerprint helpers with stable normalization:
   - `src/lib/intents/dedupe.ts`
3. Shared export wiring:
   - `src/temporal/shared/types.ts`
4. Contract and dedupe tests:
   - `tests/intent-policy-queue-contracts.test.ts`
   - `tests/intent-dedupe.test.ts`
5. Validation commands:
   - `pnpm exec vitest run tests/intent-policy-queue-contracts.test.ts tests/intent-dedupe.test.ts`
   - `pnpm test`

### Phase 1: Intent Ingestion Without Execution Ownership Change

Next, we introduce queue ingestion behind flags while keeping legacy enrich as execution authority. This is the phase that introduces the DB schema/repo surface. Sync stubs can enqueue `sync_minimal` intents, and manual/operator flows can enqueue `follow_conversation` and `topic_hunt` intents.

The system should prove idempotent enqueue semantics and zero regression when flags are off.

#### Phase 1 progress notes (Chunk 1 complete on 2026-02-22)

1. Landed durable queue schema and indexes in startup migration path:
   - `src/lib/db/schema.ts`
2. Added explicit active-intent dedupe uniqueness at DB level:
   - partial unique index `idx_intents_dedupe_active`
3. Added schema migration coverage:
   - `tests/intent-schema-migration.test.ts`
4. Added typed DB contract for queue row representation:
   - `src/types/db.ts` (`DbEnrichmentIntent`)

#### Phase 1 progress notes (Chunk 2 complete on 2026-02-22)

1. Added queue repo surface for ingestion primitives:
   - `src/lib/db/enrichment-intent-repo.ts`
   - Methods: dedupe-aware transactional `enqueue`, `getById`, `getActiveByDedupeKey`
2. Wired queue repo access into DB client facade:
   - `src/lib/db/client.ts`
   - Methods: `enqueueEnrichmentIntent`, `getEnrichmentIntent`, `getActiveEnrichmentIntentByDedupeKey`
3. Added DB integration coverage for enqueue/getById/dedupe no-op behavior:
   - `tests/db.test.ts` (`enrichment intents` describe block)

#### Phase 1 progress notes (Chunk 3 complete on 2026-02-22)

1. Added shared queue payload codec/guard surface:
   - `src/temporal/shared/intent-payload-codec.ts`
   - Includes: enqueue payload validation, deterministic encoding/fingerprints/dedupe generation, policy/rules JSON decode helpers
2. Expanded runtime contract guards in shared intent types:
   - `src/temporal/shared/intent-types.ts`
3. Integrated policy payload sanitization in execution paths:
   - `src/temporal/workflows/enrich/index.ts`
   - `src/temporal/activities/store.ts`
4. Added activity wrappers for payload validation/encoding:
   - `src/temporal/activities/intent.ts`
5. Added test coverage for shared codecs and activity wrappers:
   - `tests/intent-payload-codec.test.ts`
   - `tests/temporal-intent-activities.test.ts`

#### Phase 1 progress notes (Chunk 4 complete on 2026-02-22)

1. Added enqueue activity entry points for all planned intent types:
   - `enqueueSyncMinimalIntent`
   - `enqueueFollowConversationIntent`
   - `enqueueTopicHuntIntent`
   - File: `src/temporal/activities/intent.ts`
2. Wired enqueue activity input/output contracts in shared activity types:
   - `src/temporal/shared/activity-types.ts`
3. Enqueue path now applies shared payload codec normalization + durable repo enqueue in one place.
4. Added integration tests for created vs de-duped behavior:
   - `tests/temporal-intent-activities.test.ts`

#### Phase 1 progress notes (Chunk 5 complete on 2026-02-22)

1. Added manual CLI enqueue surface:
   - `src/commands/sync/intent.ts`
2. Added sync command registration for the new intent subcommand:
   - `src/commands/sync/register.ts`
3. Manual enqueue now supports all three intent types with shared validation path and optional overrides:
   - source/lane/priority/policy/rules/not-before/expires-at/max-attempts
4. Added command routing tests:
   - `tests/sync-intent-command.test.ts`

#### Phase 1 progress notes (Chunk 6 complete on 2026-02-22)

1. Added intent queue rollout config flags:
   - `INTENT_QUEUE_INGEST_ENABLED`
   - `INTENT_QUEUE_EXECUTION_ENABLED`
   - `LEGACY_ENRICH_AUTHORITATIVE`
   - Files: `src/lib/config.ts`, `src/types/config.ts`, `.env.example`
2. Defaults are legacy-safe (ingest off, execution off, legacy authority on).
3. Gated manual CLI enqueue commands on ingest flag:
   - `src/commands/sync/intent.ts`
4. Added config coverage for new flags:
   - `tests/config-enrich-policy.test.ts`

#### Phase 1 progress notes (Chunk 7 complete on 2026-02-22)

1. Completed enqueue validation + idempotency test coverage:
   - `tests/db.test.ts` (durable dedupe-aware enqueue behavior)
   - `tests/intent-payload-codec.test.ts` (payload validation/normalization)
   - `tests/temporal-intent-activities.test.ts` (activity enqueue dedupe + invalid input rejection)
   - `tests/sync-intent-command.test.ts` (manual CLI route coverage)
2. P1 exit gates are now satisfied in tracker with full lint/typecheck/test green runs.

### Phase 2: Dispatcher and Lane Workers

Once ingestion is stable, we add execution infrastructure:

- fixed-ID dispatcher workflow,
- lane worker workflows with deterministic ordering,
- lease lifecycle activities (`lease`, `renew`, `ack`, `fail`, `requeue`, `expire`),
- weighted round-robin scheduling with starvation floor.

At this stage, correctness under restart/failover is the priority.

#### Phase 2 progress notes (Chunk 8 complete on 2026-02-22)

1. Completed `P2-01` fixed-ID dispatcher scaffold:
   - Added `intentDispatcherWorkflow` with deterministic polling loop, pause/resume/cancel signals, and progress query output.
   - Added shared contract constant `INTENT_DISPATCHER_WORKFLOW_ID = 'enrich-intent-dispatcher'`.
2. Wired dispatcher orchestration into operator surfaces:
   - Added workflow start handler for `workflow start intent-dispatcher` that enforces the fixed workflow ID.
   - Added dispatcher support to workflow control (`pause/resume/cancel`), status progress rendering, and workflow list query filtering.
3. Added targeted regression tests:
   - `tests/temporal-intent-dispatcher-workflow.test.ts`
   - `tests/workflow-start-intent-dispatcher.test.ts`
4. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 9 complete on 2026-02-22)

1. Completed `P2-02` lane worker scaffold with deterministic ordering:
   - Added `intentLaneWorkerWorkflow` with lane-scoped processing loop.
   - Added deterministic ordering helper and contract application:
     - `priority DESC`, `createdAt ASC`, `intentId ASC`, `leaseToken ASC`.
2. Added lane worker runtime controls:
   - pause/resume/cancel signals.
   - `enqueueLeasedIntents` signal for leased batch ingestion.
   - progress query with lane/cycle/pending/processed visibility.
3. Wired operator surfaces:
   - Added `workflow start intent-lane-worker --lane <urgent-sync|analysis|background-topic>`.
   - Added workflow control/status/list support for lane worker workflow type.
4. Added targeted regression tests:
   - `tests/temporal-intent-lane-worker-workflow.test.ts`
   - `tests/workflow-start-intent-lane-worker.test.ts`
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 10 complete on 2026-02-22)

1. Completed `P2-03` lease lifecycle API implementation:
   - Added queue repo operations for `lease`, `renew`, `ack`, `fail`, `requeue`, and `expire`.
   - Implemented token-checked CAS guards for mutation APIs (`renew/ack/fail/requeue`).
2. Implemented expiry handling paths:
   - Lease expiry reclaim path requeues stale leased intents.
   - Intent expiry path marks active intents terminal (`expired`) with audit fields preserved.
3. Wired runtime surfaces for workflows:
   - Added `BookmarksDb` wrappers for all lease APIs.
   - Added Temporal activity contracts + implementations for lease lifecycle operations.
4. Added targeted regression coverage:
   - `tests/db.test.ts` now validates deterministic lease ordering, token-CAS semantics, fail/requeue behavior, and expiry behavior.
   - `tests/temporal-intent-activities.test.ts` now validates lease activity flows end-to-end.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 11 complete on 2026-02-22)

1. Completed `P2-04` dispatcher scheduler policy:
   - Added weighted round-robin lane selection based on `INTENT_LANE_WEIGHTS`.
   - Added starvation-floor forcing using `INTENT_STARVATION_FLOOR_CYCLES` so long-skipped ready lanes are promoted.
2. Added deterministic scheduler scaffolding controls:
   - New dispatcher signal `setReadyLanes` to update ready-lane set without nondeterministic external reads.
3. Expanded dispatcher telemetry state:
   - Progress now reports selected-lane history via `lastSelectedLane`, per-lane selection counts, and per-lane skip-cycle counters.
   - Workflow result now includes lane selection counts for run-level verification.
4. Added scheduler-focused regression tests:
   - `tests/temporal-intent-dispatcher-workflow.test.ts` now validates starvation-floor selection and ready-lane constrained routing.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 12 complete on 2026-02-22)

1. Completed `P2-05` workflow history rollover support:
   - Added `continueAsNew` threshold checks to both dispatcher and lane worker workflows.
   - Checks now honor history-length, history-size, and SDK `continueAsNewSuggested` signals.
2. Added carry-forward preservation across continuation runs:
   - Dispatcher now preserves cycle counts, lane selection metrics, scheduler cursor/skip counters, and ready-lane state.
   - Lane worker now preserves processed IDs, cycle count, pending leased intents, and timing state.
3. Added continuation regression coverage:
   - Dispatcher tests now assert threshold-triggered continuation and carry-forward restoration behavior.
   - Lane worker tests now assert threshold-triggered continuation and carry-forward restoration behavior.
4. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 13 complete on 2026-02-22)

1. Completed `P2-06` queue-status query surfaces:
   - Added queue status snapshot query support in intent repo + DB facade:
     - lane-level health (`queued`, `failedRetryable`, `leased`, `overdueLeases`, `oldestReadyCreatedAt`),
     - global totals,
     - lease conflict counters (`active`, `total`).
2. Wired Temporal activity contract and implementation for queue status snapshots:
   - Added `getIntentQueueStatus` in shared activity types and activity implementation.
3. Extended dispatcher observability state:
   - Dispatcher now refreshes queue status each cycle via activity and exposes it through `progressQuery` as `queueStatus`.
4. Extended CLI workflow status rendering for dispatcher:
   - `workflow status` now prints queue totals, per-lane health, overdue leases, and lease conflict metrics.
5. Added targeted regression coverage:
   - `tests/temporal-intent-activities.test.ts` validates queue status snapshot semantics.
   - `tests/temporal-intent-dispatcher-workflow.test.ts` validates queue status presence in progress query snapshots.
6. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 2 progress notes (Chunk 14 complete on 2026-02-22)

1. Completed `P2-07` reliability-focused test expansion:
   - Added lease failover regression in DB tests covering:
     - lease expiry reclaim,
     - stale-token mutation rejection after failover,
     - successful re-lease and terminal ack by replacement worker.
2. Added determinism + starvation simulation coverage in dispatcher scheduler tests:
   - Deterministic replay test verifies identical lane sequence output for equivalent mixed-load ready-lane patterns.
   - Long-run mixed-load simulation verifies starvation protection behavior and lane service coverage.
3. Phase 2 exit gates are now satisfied in tracker:
   - lease/retry correctness under failover tests,
   - no starvation under mixed-load simulation.
4. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 3 progress notes (Chunk 15 complete on 2026-02-22)

1. Completed `P3-01` intent-policy mapping to existing enrich execution paths:
   - Added workflow adapter `mapLeasedIntentToEnrichBatchInput` to map leased intent metadata and policy payloads into deterministic `enrichRecordsBatch` input contracts.
   - Extended lane worker execution path to consume intent metadata (`intentType`, `tweetId`, `policy`) and route execution through intent-aware enrich activity calls.
2. Added store-side bridge to existing enrich behavior:
   - Added `executeIntentEnrichment` activity in `store.ts` to translate intent-type defaults and policy overrides into the existing batch enrich path.
   - Preserved existing enrich semantics while enabling intent-scoped execution mapping.
3. Extended queue lease payload surface for mapping:
   - Lease activity output now includes `intentType` and decoded `policy` payload for downstream mapping without additional DB lookups.
4. Added targeted regression coverage:
   - `tests/intent-policy-adapter.test.ts`
   - `tests/temporal-intent-lane-worker-workflow.test.ts`
   - `tests/temporal-activities.test.ts`
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 3 progress notes (Chunk 16 complete on 2026-02-22)

1. Completed `P3-02` bounded `topic_hunt` discovery path:
   - Added topic-search fetch activity (`fetchTopicTweetsPage`) using enrichment source recent-search capabilities with rate-limit/api-call metadata.
   - Added source/client support for generic recent-search queries in X API path.
2. Added execution-bounded topic discovery behavior in store activity:
   - `executeIntentEnrichment` now executes `topic_hunt` using query metadata from rules.
   - Discovery is bounded by explicit page caps, per-page result caps, discovery-age filtering, and API-call budget checks.
3. Extended intent metadata flow needed for topic execution:
   - Topic enqueue encoding now persists deterministic topic-hunt query metadata in rules payload.
   - Lease activity outputs now include decoded rules payload for lane-worker execution without extra lookups.
4. Added targeted regression coverage:
   - `tests/temporal-fetch-activities.test.ts` for topic-search page fetch behavior.
   - `tests/temporal-activities.test.ts` for bounded topic-hunt execution semantics.
   - `tests/temporal-intent-activities.test.ts`, `tests/intent-payload-codec.test.ts`, and `tests/temporal-intent-lane-worker-workflow.test.ts` for metadata propagation + execution mapping.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 3 progress notes (Chunk 17 complete on 2026-02-22)

1. Completed `P3-03` per-intent and per-lane budget checks pre-step:
   - Added lane execution budget defaults/contracts in shared intent types.
   - Lane worker now enforces per-cycle lane budgets before each intent execution step and defers remaining intents when lane budget is exhausted.
2. Added explicit budget stop-reason tracking in lane execution telemetry:
   - Lane worker now tracks and reports `intent_budget_exhausted` and `lane_budget_exhausted` counters in progress/result surfaces.
3. Tightened per-intent fanout cap propagation:
   - `maxRelatedPostsPerRun` now constrains seed-driven mode fanout caps through both workflow adapter mapping and store-side intent execution mapping.
4. Added targeted regression coverage:
   - `tests/temporal-intent-lane-worker-workflow.test.ts` for lane-budget pre-step enforcement and budget stop-reason accounting.
   - `tests/intent-policy-adapter.test.ts` and `tests/temporal-activities.test.ts` for fanout-cap propagation behavior.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 3 progress notes (Chunk 18 complete on 2026-02-22)

1. Completed `P3-04` discovered-context persistence invariants (tweet rows only):
   - Added regression assertions across origin, conversation, quotes, and topic-hunt discovery flows confirming discovered IDs are persisted as tweet rows but never materialized as bookmark rows.
2. Confirmed seed bookmark integrity under discovery:
   - Seed bookmark rows remain stable while discovered context is added to tweet/media/user tables.
3. Added targeted regression coverage:
   - `tests/temporal-activities.test.ts` now checks bookmark-table invariants for discovered context across bounded discovery modes.
4. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 3 progress notes (Chunk 19 complete on 2026-02-22)

1. Completed `P3-05` bounded fanout and overlap-idempotency test expansion:
   - Added topic-hunt overlap regression coverage ensuring duplicate overlap across pages does not consume bounded discovery fanout budget.
   - Added repeated-run overlap coverage ensuring discovered tweet persistence remains idempotent across overlapping topic-hunt runs.
2. Confirmed Phase 3 exit criteria with full validation pass:
   - policy-aware execution remains observable via existing budget/stop-reason surfaces,
   - bounded discovery fanout behavior is locked by regression coverage for all supported discovery paths.
3. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 20 complete on 2026-02-22)

1. Completed `P4-01` shadow metrics enablement with legacy execution ownership preserved:
   - Sync workflow now supports shadow-mode enqueue of `sync_minimal` intents when queue ingest is enabled while queue execution remains disabled and legacy enrich remains authoritative.
2. Added rollout-observability counters for shadow mode:
   - Sync progress/status now reports shadow intent ingest counters (`attempted`, `enqueued`, `deduped`, `failed`) and ingest-enabled state for operator visibility.
3. Added deterministic shadow-ingest behavior:
   - Per-page stub extraction uses deterministic dedupe/sort and stable source-scope mapping to avoid divergent enqueue signatures.
4. Added targeted regression coverage:
   - `tests/temporal-sync-workflow.test.ts` validates shadow enqueue behavior and guardrails when queue execution is enabled.
   - `tests/sync-command-routing.test.ts` validates sync workflow startup continues to route correctly with intent-queue rollout config attached.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 21 complete on 2026-02-22)

1. Completed `P4-02` limited-cohort `sync_minimal` ingestion controls:
   - Added rollout config support for sync-minimal ingest cohort percentage with clamped bounds and default-safe behavior.
   - Shadow sync ingest now applies deterministic per-tweet cohort bucketing so operators can gradually expand ingest from small cohorts.
2. Expanded shadow rollout telemetry for cohort monitoring:
   - Sync progress/status now reports cohort percentage and cohort-skipped counters in addition to attempted/enqueued/deduped/failed.
3. Ensured both sync entrypoints pass rollout config consistently:
   - `sync bookmarks` and `workflow start sync` now both propagate intent queue rollout config into workflow input.
4. Added targeted regression coverage:
   - `tests/temporal-sync-workflow.test.ts` validates cohort-limited ingest behavior.
   - `tests/config-enrich-policy.test.ts` validates cohort env parsing/clamping.
   - `tests/sync-command-routing.test.ts` validates rollout config propagation in sync workflow start input.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 22 complete on 2026-02-22)

1. Completed `P4-03` urgent-sync queue execution rollout behavior:
   - Sync workflow now enables `sync_minimal` enqueue during queue-execution mode (`ingest=true`, `execution=true`, `legacy=false`) and treats queue execution as authoritative for legacy trigger suppression when ingest succeeds.
2. Added deterministic fallback ownership for safety:
   - Legacy enrich is now triggered as a fallback on a per-page basis whenever queue ingest is partial/failed (cohort skips or enqueue exceptions), preserving migration safety without duplicate steady-state execution.
3. Expanded sync migration telemetry and operator visibility:
   - Added progress/status fields for execution migration state and outcomes:
     - `intentQueueExecutionEnabled`
     - `legacyEnrichSuppressed`
     - `legacyEnrichFallbacks`
4. Added targeted regression coverage:
   - `tests/temporal-sync-workflow.test.ts` now validates:
     - legacy enrich suppression when queue execution fully ingests sync stubs,
     - legacy fallback trigger path when queue enqueue fails.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 23 complete on 2026-02-22)

1. Completed `P4-04` analysis lane rollout controls and strict budget wiring:
   - Added intent-queue rollout config flags for per-lane execution enablement:
     - `INTENT_QUEUE_ANALYSIS_EXECUTION_ENABLED`
     - `INTENT_QUEUE_BACKGROUND_TOPIC_EXECUTION_ENABLED`
2. Added strict analysis lane budget configuration:
   - Added env-backed analysis lane budget controls with validated defaults:
     - `INTENT_QUEUE_ANALYSIS_MAX_API_CALLS_PER_CYCLE`
     - `INTENT_QUEUE_ANALYSIS_MAX_DISCOVERED_POSTS_PER_CYCLE`
3. Wired rollout controls into execution entrypoints:
   - Dispatcher start now seeds `readyLanes` from rollout config, keeping urgent-sync-first behavior until analysis/background are explicitly enabled.
   - Lane worker start now injects deterministic analysis lane budget overrides when analysis execution is enabled.
4. Added targeted regression coverage:
   - `tests/config-enrich-policy.test.ts`
   - `tests/intent-queue-rollout.test.ts`
   - `tests/workflow-start-intent-dispatcher.test.ts`
   - `tests/workflow-start-intent-lane-worker.test.ts`
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 24 complete on 2026-02-22)

1. Completed `P4-05` background-topic lane rollout controls and strict budget wiring:
   - Added env-backed background-topic lane budget controls with validated defaults:
     - `INTENT_QUEUE_BACKGROUND_TOPIC_MAX_API_CALLS_PER_CYCLE`
     - `INTENT_QUEUE_BACKGROUND_TOPIC_MAX_DISCOVERED_POSTS_PER_CYCLE`
2. Extended lane budget override resolution for rollout safety:
   - `resolveIntentLaneBudgetOverride` now supports both analysis and background-topic lanes, only applying overrides when each lane is explicitly enabled by rollout config.
3. Confirmed dispatcher/worker rollout integration for background-topic:
   - Dispatcher ready-lane seeding includes background-topic when enabled.
   - Lane worker start injects strict background-topic budget overrides when enabled.
4. Added targeted regression coverage:
   - `tests/config-enrich-policy.test.ts`
   - `tests/intent-queue-rollout.test.ts`
   - `tests/workflow-start-intent-dispatcher.test.ts`
   - `tests/workflow-start-intent-lane-worker.test.ts`
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 4 progress notes (Chunk 25 complete on 2026-02-22)

1. Completed `P4-06` rollout-gate validation and rollback-readiness tooling:
   - Added deterministic gate evaluation for queue wait SLA proxies, lease/backlog envelopes, and failure-budget checks.
2. Added rollback-readiness checks tied to sync telemetry:
   - Validates that queue execution telemetry is present and exposes `intentQueueExecutionEnabled` + `legacyEnrichFallbacks`.
   - Supports optional strict mode requiring observed legacy fallback exercise.
3. Added rollout operator CLI entrypoint:
   - `pnpm dev workflow rollout-gates --dispatcher-id enrich-intent-dispatcher [--sync-workflow-id <id>]`.
4. Added regression coverage:
   - `tests/intent-rollout-gates.test.ts`.
5. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 5 progress notes (Chunk 26 complete on 2026-02-22)

1. Completed `P5-01` emergency fallback switch hardening:
   - Rollout helper semantics now treat `legacyEnrichAuthoritative=true` as a hard queue-execution stop.
   - Dispatcher ready-lane seeding resolves to `[]` and lane-budget overrides are disabled under emergency fallback.
2. Added explicit regression coverage for fallback semantics:
   - `tests/intent-queue-rollout.test.ts`
   - `tests/workflow-start-intent-dispatcher.test.ts`
   - `tests/workflow-start-intent-lane-worker.test.ts`
3. Added operator-facing rollback documentation:
   - `README.md` now documents emergency fallback steps, verification, and gate checks.
   - `.env.example` now includes explicit emergency fallback guidance.
4. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 5 progress notes (Chunk 27 complete on 2026-02-22)

1. Completed `P5-01a` runtime-operations simplification for queue mode:
   - Added idempotent runtime ensure helper that boots dispatcher + enabled lane workers with stable workflow IDs and already-running tolerance.
2. Improved sync operator UX for intent execution:
   - `pnpm dev sync <folder-id>` now auto-ensures intent runtime when queue execution is enabled.
3. Added explicit bootstrap command for manual control:
   - `pnpm dev workflow start intent-runtime`.
4. Hardened manual start command ergonomics for runtime services:
   - `workflow start intent-lane-worker` now defaults to stable per-lane IDs.
   - dispatcher/lane-worker start commands now treat already-started errors as non-fatal ("already running").
5. Added regression coverage:
   - `tests/intent-runtime-workflows.test.ts`
   - `tests/workflow-start-intent-runtime.test.ts`
   - `tests/sync-command-routing.test.ts` (queue-runtime auto-ensure behavior)
   - `tests/workflow-start-intent-dispatcher.test.ts` and `tests/workflow-start-intent-lane-worker.test.ts` (already-running/idempotent start behavior)
6. Validation completed:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 6 planning notes (Chunk 28 prepared on 2026-02-22)

1. Added planned Phase 6 scope for workflow-attached policy profiles:
   - Introduce a versioned profile registry file (YAML/JSON) with named enrichment presets.
2. Defined ownership boundaries for clarity:
   - Global env/config remains authoritative for runtime ownership/fallback/lane budgets.
   - Profile registry becomes authoritative for per-workflow enrich behavior (mode/caps).
3. Defined policy resolution precedence:
   - explicit `--policy <name>` override,
   - workflow default profile,
   - existing env-derived enrich defaults as fallback.
4. Defined determinism requirement:
   - resolve + sanitize profile at enqueue/start time and persist concrete snapshot in workflow/intent payload.
   - lane worker execution must consume persisted snapshot only.
5. Defined backward-compatibility expectation:
   - env-only behavior remains valid when no profile is selected.

#### Phase 6 progress notes (Chunk 29 complete on 2026-02-24)

1. Completed `P6-01` as a contract-first implementation slice.
2. Added a versioned policy profile registry contract module:
   - `src/lib/intents/policy-profile-registry-contract.ts`
   - Defines v1 schema contract, profile naming rules, canonical file location constants, and runtime shape guards.
3. Added the canonical registry file at:
   - `config/enrichment-policy-profiles.v1.json`
4. Added contract lock tests:
   - `tests/enrichment-policy-profile-registry-contract.test.ts`
   - Verifies canonical path/version, validates canonical file against the contract, and rejects invalid contract shapes.
5. Validation completed:
   - `pnpm exec vitest run tests/enrichment-policy-profile-registry-contract.test.ts`
   - `pnpm run typecheck`
   - `pnpm run lint`
6. Runtime behavior intentionally unchanged in this chunk:
   - no loader/config integration yet,
   - no policy-resolution precedence changes yet,
   - no CLI/workflow behavior changes yet.

#### Phase 6 progress notes (Chunk 30 complete on 2026-02-24)

1. Completed `P6-02` by implementing config-layer registry loading and strict validation.
2. Added loader in `src/lib/config.ts`:
   - `loadEnrichPolicyProfileRegistry()` resolves deterministic path defaults and parses registry JSON.
   - Supports optional override via `ENRICH_POLICY_PROFILE_REGISTRY_PATH`.
3. Added explicit fail-fast error classification:
   - missing/unreadable registry file,
   - invalid JSON payload,
   - invalid registry contract shape.
4. Wired `loadConfig()` startup to validate registry eagerly so misconfiguration fails before queue/runtime execution.
5. Added regression coverage:
   - `tests/config-policy-profile-registry.test.ts`
   - Validates default load, override path behavior, and all fail-fast error branches.
6. Validation completed:
   - `pnpm exec vitest run tests/config-policy-profile-registry.test.ts tests/enrichment-policy-profile-registry-contract.test.ts`
   - `pnpm run typecheck`
   - `pnpm run lint`

#### Phase 6 progress notes (Chunk 31 complete on 2026-02-24)

1. Completed `P6-03` by wiring profile-precedence selection into sync and manual intent enqueue command paths.
2. Added shared precedence resolver:
   - `src/lib/intents/policy-profile-selection.ts`
   - precedence order enforced:
     - explicit `--policy <name>`,
     - workflow default profile,
     - env-derived fallback policy.
3. Added CLI plumbing for named profiles:
   - `sync` bookmarks command now accepts `--policy <name>`.
   - `workflow start sync` now accepts `--policy <name>`.
   - `sync intent ...` commands now accept `--policy <name>`.
4. Manual enqueue behavior retained and clarified:
   - existing `--policy-json` path remains supported,
   - `--policy` and `--policy-json` are now mutually exclusive to avoid ambiguous precedence.
5. Added regression tests:
   - `tests/policy-profile-selection.test.ts`
   - `tests/sync-command-routing.test.ts`
   - `tests/sync-intent-command.test.ts`
6. Validation completed:
   - `pnpm exec vitest run tests/policy-profile-selection.test.ts tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts`
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 6 progress notes (Chunk 32 complete on 2026-02-24)

1. Completed `P6-04` by persisting resolved policy snapshots through workflow and intent payload boundaries.
2. Sync workflow input now carries policy + rules snapshots:
   - `enrichPolicy`
   - `enrichRules`
3. Sync page processing now enqueues `sync_minimal` intents with workflow-provided snapshots instead of hardcoded inline policy defaults.
4. Intent enqueue activity inputs were extended so rules snapshots persist for:
   - `sync_minimal`
   - `follow_conversation`
   - `topic_hunt`
5. Lane execution determinism strengthened:
   - lane workers continue executing leased `policy_json` / `rules_json` snapshots only,
   - no runtime mutable profile lookup is required during leased intent execution.
6. Added and updated regression tests:
   - `tests/temporal-sync-workflow.test.ts` (sync -> enqueue snapshot propagation)
   - `tests/sync-command-routing.test.ts` (sync command snapshot handoff)
   - `tests/sync-intent-command.test.ts` (manual enqueue rules/policy snapshot persistence)
7. Validation completed:
   - `pnpm exec vitest run tests/temporal-sync-workflow.test.ts tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts tests/policy-profile-selection.test.ts`
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm test`

#### Phase 6 progress notes (Chunk 33 complete on 2026-02-24)

1. Completed `P6-05` by closing documentation and command-level regression gaps for policy profiles.
2. Added operator-facing profile docs:
   - `README.md` now documents profile precedence, command usage, and registry path override.
   - `.env.example` now includes `ENRICH_POLICY_PROFILE_REGISTRY_PATH`.
   - `docs/operations/enrichment-runtime-cheatsheet.md` now includes named-profile precedence and run commands.
3. Added backward-compatibility regression coverage:
   - `tests/sync-command-routing.test.ts` now verifies env fallback when no sync workflow default profile exists.
   - `tests/sync-intent-command.test.ts` now verifies env fallback when no intent workflow default profile exists.
   - `tests/sync-command-routing.test.ts` now verifies unknown `--policy` fails fast with a clear error.
4. Maintained deterministic execution boundary:
   - policy/rule snapshots remain resolved at command/workflow enqueue boundaries,
   - lane execution continues to consume persisted snapshots only.
5. Validation completed:
   - `pnpm exec vitest run tests/sync-command-routing.test.ts tests/sync-intent-command.test.ts`
   - `pnpm run typecheck`
   - `pnpm run lint`

### Phase 3: Policy-Aware Execution

With stable queue mechanics, intents begin driving actual policy behavior:

- `sync_minimal` maps to conservative enrichment (`atomic`),
- `follow_conversation` maps to bounded origin/conversation/quotes behavior,
- `topic_hunt` maps to bounded search-driven discovery.

Per-intent and per-lane budgets are checked before each external step to preserve bounded fanout behavior.

### Phase 4: Progressive Migration

Ownership shifts gradually:

1. shadow metrics only,
2. limited `sync_minimal` cohort,
3. `urgent-sync` execution enablement,
4. then `analysis`,
5. then `background-topic`.

Each stage advances only after SLA/cost/error gates pass.

### Phase 5: Legacy Wind-Down

Legacy enrich remains available until queue execution demonstrates sustained stability. Only then do we decommission legacy trigger paths, while retaining an emergency rollback path and updated operations docs.

### Phase 6: Workflow-Attached Policy Profiles (Completed through P6-05)

Phase 6 introduces named, reusable enrichment policy profiles so commands/workflows can opt into behavior without codepath forks.

The core shape:

1. a versioned profile registry file,
2. strict loader/validation,
3. explicit profile selection and precedence,
4. deterministic policy snapshot persistence into queued work.

This gives operator-friendly policy control while preserving deterministic Temporal execution and existing global runtime safety controls.

## Architecture Principles

1. Workflows orchestrate deterministically; activities own external I/O.
2. Lease semantics are CAS-safe and stale-token resistant.
3. Writes remain idempotent and conflict-safe.
4. Discovered context remains tweet-row-only data.
5. Lane isolation protects sync latency from exploratory workloads.

## High-Risk Areas and Mitigations

### Lease correctness drift

Risk: stale workers incorrectly acknowledge newer leases.
Mitigation: require `id + lease_token` match for all terminal transitions.

### Priority inversion / starvation

Risk: high-volume low-priority lanes or vice versa block each other.
Mitigation: weighted round-robin plus starvation floor and lane quotas.

### Dedupe ambiguity

Risk: duplicate intents due to unstable target/rule normalization.
Mitigation: deterministic fingerprinting + explicit supersession semantics.

### Migration confusion

Risk: unclear execution authority during rollout causes double work or missed work.
Mitigation: ownership matrix with clear fallback path by stage.

## Verification Approach

Verification should cover:

1. lifecycle transition validity,
2. dedupe and supersession behavior,
3. lease CAS and stale-token rejection,
4. deterministic lane ordering under retries,
5. starvation prevention under mixed-load simulations,
6. regression parity with queue features disabled.

## Operational Readiness Expectations

Before broad rollout:

1. lane-level metrics and queue depth visibility must be queryable,
2. stop reasons must be attributable by lane and intent type,
3. p95 queue wait and completion latency should be measured against targets,
4. rollback switch behavior must be tested, not assumed.

## Suggested Decision Log Entries

Capture final decisions for:

1. `topic_hunt` dedupe windowing strategy,
2. default supersession behavior for manual intents,
3. static vs runtime-adjustable lane caps,
4. criteria for permanently disabling legacy enrich trigger path.

## Notes

This writeup is intentionally prose-first to explain intent, sequencing, and risk posture.
Use the companion checklist doc for granular execution tracking:
`.project/tasks/2026-02-22-enrichment-intents-policy-queue-implementation-checklist.md`.
