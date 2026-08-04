# Thread-Aware Enrichment Implementation Tracker (v0)

**Status:** Implementation complete through P4 + hardening; P5 rollout validation in progress
**Created:** 2026-02-21
**Plan Reference:** `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`

Use this as a direct execution tracker. Keep it lightweight and editable while planning/process conventions are still evolving.

## Phase Board

| Phase | Goal | Status | Start | End | PR |
| --- | --- | --- | --- | --- | --- |
| P0 | Readiness lock | COMPLETE | 2026-02-21 | 2026-02-21 | - |
| P1 | Batch hydration (`atomic`) | COMPLETE | 2026-02-21 | 2026-02-21 | - |
| P2 | Policy, budget, telemetry | COMPLETE | 2026-02-21 | 2026-02-21 | - |
| P3 | Origin chain expansion | COMPLETE | 2026-02-21 | 2026-02-21 | - |
| P4 | Conversation + quotes (opt-in) | COMPLETE | 2026-02-22 | 2026-02-22 | - |
| P5 | Rollout + validation | IN PROGRESS | 2026-02-22 | - | - |

## Hardening Status

- [x] Post-implementation code review findings are complete.
  - Evidence: `.project/tasks/2026-02-22-thread-aware-enrichment-code-review-findings.md`
  - Commits: `25171f1`, `ac2830b`, `9fe6353`

## P0: Readiness Lock

- [x] `P0-01` Freeze batch contract: per-ID outcomes (`ok | unavailable | failed`) + `retryable`.
  - Output: contract note in plan + shared type stubs.
  - Evidence: `src/lib/api/types.ts`, `src/sources/types.ts`, `src/temporal/shared/activity-types.ts`
- [x] `P0-02` Freeze config keys/defaults (`enrich.*` caps/budgets).
  - Output: config key list in plan and code TODOs.
  - Evidence: `src/lib/config.ts`, `src/types/config.ts`, `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`
- [x] `P0-03` Freeze persistence semantics (discovered posts are tweet rows only; never bookmarks).
  - Output: persistence rules note.
  - Evidence: `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`, `src/temporal/activities/store.ts`
- [x] `P0-04` Freeze deterministic ordering + dedupe + budget stop reasons.
  - Output: workflow behavior note.
  - Evidence: `src/temporal/workflows/enrich/pass.ts`, `src/temporal/workflows/enrich/index.ts`, `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`
- [x] `P0-05` Freeze rollout gates + acceptance thresholds + test matrix.
  - Output: rollout/test checklist signed off.
  - Evidence: `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`, `.project/tasks/2026-02-21-thread-aware-enrichment-get-posts-by-ids-narrative-task-writeup.md`

### P0 Exit Gate

- [x] P0 complete and reviewed.

## P1: Batch Hydration Foundation (`atomic`)

- [x] `P1-01` Add batch endpoint builder + shared endpoint limit constant.
  - Files: `src/lib/api/client/endpoints.ts`
  - Depends on: `P0-01`
  - Evidence: `src/lib/api/client/endpoints.ts`
- [x] `P1-02` Add batch API types.
  - Files: `src/lib/api/types.ts`, `src/sources/types.ts`
  - Depends on: `P0-01`
  - Evidence: `src/lib/api/types.ts`, `src/sources/types.ts`, `src/lib/api.ts`
- [x] `P1-03` Implement API client batch call (`getTweetsByIds(ids)`).
  - File: `src/lib/api/x-api-client.ts`
  - Depends on: `P1-01`, `P1-02`
  - Evidence: `src/lib/api/x-api-client.ts`, `src/lib/api/client/parsers.ts`
- [x] `P1-04` Add datasource batch fetch (`fetchTweetDetailsBatch(ids)`) while preserving single-ID path.
  - File: `src/sources/x-api.ts`
  - Depends on: `P1-03`
  - Evidence: `src/sources/x-api.ts`, `src/sources/selection.ts`
- [x] `P1-05` Add Temporal batch activity contracts/wiring.
  - Files: `src/temporal/shared/activity-types.ts`, `src/temporal/shared/types.ts`, `src/temporal/activities/fetch.ts`, `src/temporal/activities/store.ts`
  - Depends on: `P1-04`
  - Evidence: `src/temporal/shared/activity-types.ts`, `src/temporal/activities/fetch.ts`, `src/temporal/activities/store.ts`
- [x] `P1-06` Update enrich pass to deterministic batch processing and per-pass dedupe.
  - File: `src/temporal/workflows/enrich/pass.ts`
  - Depends on: `P1-05`
  - Evidence: `src/temporal/workflows/enrich/pass.ts`
- [x] `P1-07` Add tests: mixed batch outcomes + atomic parity + overlap dedupe.
  - Files: relevant unit/workflow/integration tests
  - Depends on: `P1-06`
  - Evidence: `tests/api.test.ts`, `tests/x-api-source.test.ts`, `tests/temporal-fetch-activities.test.ts`, `tests/temporal-activities.test.ts`, `tests/temporal-enrich-workflow.test.ts`
- [x] `P1-08` Update docs for atomic batching behavior.
  - File: `README.md`
  - Depends on: `P1-06`
  - Evidence: `README.md`

### P1 Exit Gate

- [x] Atomic behavior parity validated.
- [ ] Request count reduction recorded.
- [x] No duplicate-write or error-rate regression.

## P2: Policy, Budget, Telemetry

- [x] `P2-01` Add `enrich.*` config keys/defaults + endpoint cap clamping.
  - Depends on: `P0-02`
  - Evidence: `src/lib/config.ts`, `src/types/config.ts`, `src/temporal/workflows/enrich/index.ts`, `src/temporal/shared/enrich-types.ts`
- [x] `P2-02` Add run-level budget state + stop reasons.
  - Depends on: `P2-01`
  - Evidence: `src/temporal/workflows/enrich/runtime.ts`, `src/temporal/workflows/enrich/pass.ts`, `src/temporal/shared/enrich-types.ts`
- [x] `P2-03` Add mode counters and stop-reason metrics/logs.
  - Depends on: `P2-02`
  - Evidence: `src/temporal/workflows/enrich/index.ts`, `src/commands/workflow/start-command/enrich.ts`
- [x] `P2-04` Add cost/latency documentation for policy tradeoffs.
  - File: `docs/cost-model.md`
  - Depends on: `P2-03`
  - Evidence: `docs/cost-model.md`
- [x] `P2-05` Add tests for budget stops and deterministic ordering.
  - Depends on: `P2-02`
  - Evidence: `tests/temporal-enrich-workflow.test.ts`, `tests/config-enrich-policy.test.ts`

### P2 Exit Gate

- [x] Budget stop behavior is deterministic and observable.
- [x] Telemetry is sufficient for rollout decisions.

## P3: Origin Chain Expansion

- [x] `P3-01` Implement `replied_to` parent-chain resolver with depth caps.
  - Depends on: `P2-01`
  - Evidence: `src/temporal/activities/store.ts`
- [x] `P3-02` Batch fetch missing ancestors and dedupe across seeds.
  - Depends on: `P3-01`
  - Evidence: `src/temporal/activities/store.ts`, `src/temporal/activities/fetch.ts`
- [x] `P3-03` Persist ancestry records/edges idempotently.
  - Depends on: `P3-02`
  - Evidence: `src/temporal/activities/store.ts`, `src/lib/db/tweet-write-repo.ts`
- [x] `P3-04` Add tests for cap stops and retry idempotency.
  - Depends on: `P3-03`
  - Evidence: `tests/temporal-activities.test.ts`, `tests/temporal-enrich-workflow.test.ts`, `tests/temporal-fetch-activities.test.ts`

### P3 Exit Gate

- [x] Parent-chain reconstruction meets target.
- [x] No cap overruns and no non-determinism regressions.

## P4: Conversation + Quote Expansion (Opt-In)

- [x] `P4-01` Implement `conversation_id` expansion with strict page/post/time caps.
  - Depends on: `P2-01`
  - Evidence: `src/temporal/activities/store.ts`, `src/temporal/activities/fetch.ts`, `src/lib/api/client/endpoints.ts`
- [x] `P4-02` Implement quote expansion with strict caps.
  - Depends on: `P2-01`
  - Evidence: `src/temporal/activities/store.ts`, `src/temporal/activities/fetch.ts`, `src/lib/api/x-api-client.ts`
- [x] `P4-03` Enforce run-level budget checks on each discovery step.
  - Depends on: `P4-01`, `P4-02`
  - Evidence: `src/temporal/workflows/enrich/pass.ts`, `src/temporal/activities/store.ts`
- [x] `P4-04` Keep modes explicitly gated and default-off.
  - Depends on: `P4-01`, `P4-02`
  - Evidence: `src/lib/config.ts`, `src/temporal/workflows/enrich/index.ts`, `src/temporal/activities/store.ts`
- [x] `P4-05` Add bounded-fanout + overlap safety tests.
  - Depends on: `P4-03`
  - Evidence: `tests/temporal-activities.test.ts`, `tests/temporal-fetch-activities.test.ts`

### P4 Exit Gate

- [x] Fan-out remains bounded under test profiles.
- [x] Cost/latency stay within accepted thresholds.

## P5: Rollout + Validation

- [x] `P5-01` Ship P1 only (`atomic` batching).
  - Depends on: `P1` exit
  - Evidence: `src/lib/config.ts`, `src/temporal/workflows/enrich/index.ts`, `src/temporal/workflows/sync/enrich-orchestrator.ts`, `README.md`, `docs/cost-model.md`
- [ ] `P5-02` Collect two full sync cycles of metrics.
  - Depends on: `P5-01`
  - Evidence:
- [ ] `P5-03` Enable `origin` for limited profile and monitor.
  - Depends on: `P3` exit, `P5-02`
  - Evidence:
- [ ] `P5-04` Enable conversation/quotes only after cap stability proof.
  - Depends on: `P4` exit, `P5-03`
  - Evidence:
- [ ] `P5-05` Close out docs + final behavior notes.
  - Depends on: `P5-04`
  - Evidence:

### P5 Exit Gate

- [ ] Acceptance thresholds met (requests, p95 latency, regressions, safety incidents).
- [ ] Plan + tracker docs updated to shipped state.

## Decision Log

| Date | Decision | Why | Link |
| --- | --- | --- | --- |
| - | - | - | - |

## Change Log

| Date | Update | Author |
| --- | --- | --- |
| 2026-02-21 | Created tracker v0 | Codex |
| 2026-02-21 | Completed P1 foundation tasks (P1-01 through P1-08); validated with full test suite | Codex |
| 2026-02-21 | Completed P2 policy/budget/telemetry foundations and P3 origin-chain expansion with cap + idempotency tests | Codex |
| 2026-02-22 | Completed P4 opt-in conversation and quote expansion with strict caps, budget checks, and bounded-fanout tests | Codex |
| 2026-02-22 | Marked P5-01 complete (atomic shipped as default policy) and refreshed rollout-facing README/cost docs | Codex |
| 2026-03-04 | Synced tracker status with shipped implementation state and post-review hardening completion | Codex |
