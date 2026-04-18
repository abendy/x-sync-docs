# Task: Manual Enrich as Targeted Policy Execution

**Status:** Completed
**Created:** 2026-03-04
**Plan:** .project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md
**Ref:** a961f5

## Workflow Rules (do not remove)

- Use `/commit` after completing each chunk (not raw git commit)
- Mark completed tasks with `[x]` in this file after each chunk
- Generate chunk boundary report after each chunk
- Stop and wait for review after each chunk
- Do not batch work across chunks

## Chunks

## Decisions Applied (2026-03-05)

- `policyLane` set is explicit and context-aware: `sync.atomic`, `manual.atomic`, `manual.origin`, `manual.conversation`, `manual.quotes`
- Lane resolution is based on invocation context + policy mode (not policy mode alone)
- Manual policy-driven enrich is target-only: requires explicit tweet IDs (`--tweet-id` and/or `--file`)
- Workflow-level transient retries with durable backoff; activity-level retry loops are out of scope

### Chunk 1: Outcome Taxonomy & Retry Metadata Foundation

- [x] Expand outcome types: add `deferred_transient`, rename `failed` to `failed_terminal`, add `skipped_budget` (plan: Outcome Taxonomy) — wired through enrich workflow/activity result handling and counters
- [x] Add retry metadata DB columns: `attempt_count`, `next_retry_at`, `last_error`, `last_error_kind`, `policy_lane` (plan: Retry Policy) — added to schema, defaults, and DB model
- [x] Define `policyLane` constants: `sync.atomic`, `manual.atomic`, `manual.origin`, `manual.conversation`, `manual.quotes` (plan: Policy Lane Affinity) — added in shared enrich types and workflow lane resolution
- [x] Update shared types (`enrich-types.ts`, `activity-types.ts`, `db.ts`) to reflect new outcomes and metadata fields (plan: Outcome Taxonomy) — new outcome unions/counters + retry metadata fields
- [x] Update DB migration logic in `tweet-maintenance-repo.ts` for new columns (plan: Retry Policy) — added ensure-column migrations and index creation for retry lane/due-time

### Chunk 2: Policy Lane Wiring & Lane-Aware Record Selection

- [x] Wire `policyLane` into `EnrichWorkflowInput` and resolve from invocation context + policy mode at workflow start (plan: Policy Lane Affinity) — explicit lane flow now wired into record source and start/orchestrator call paths
- [x] Add lane-aware query methods to `tweet-query-repo.ts`: filter stubs/retryable by matching lane (plan: Sync Run Selection Order) — added lane-filtered stub/unavailable/outdated query + count methods
- [x] Update `createEnrichRecordSource` to accept and apply lane filtering (plan: Sync Run Selection Order) — source now forwards lane filters across stub/unavailable/outdated selection
- [x] Set sync-child enrich to use `sync.atomic` lane explicitly (plan: Policy Registry Integration Plan) — sync child input now sets `policyLane: sync.atomic` and sync stub checks use same lane
- [x] Set manual atomic runs to `manual.atomic` lane explicitly (plan: Policy Lane Affinity) — `workflow start enrich` now resolves manual lane from policy mode and passes explicit `policyLane`
- [x] Add carryover stub selection: same-lane failures after current-run stubs, with cap/timebox (plan: Sync Run Selection Order) — stub source now prioritizes `syncedAfter` records, then bounded same-lane carryover (`50` cap / `30s` timebox)

### Chunk 3: In-Run Transient Retry with Error Classification

- [x] Implement error classification: categorize API errors as transient (timeout/network/5xx/rate-limit) vs terminal (plan: Outcome Taxonomy) — added workflow-side thrown-error classifier and activity-side fetch error classifier
- [x] Add workflow-level pause/backoff retry loop in enrich pass processing for transient failures (plan: Retry Policy > In-run transient retry) — per-record transient retry loop now retries batch and single-record paths
- [x] Keep activity classification pure (no internal sleep/retry loop in `enrichRecordsBatch`) and surface retryable semantics to workflow (plan: Outcome Taxonomy) — batch activity remains single-pass and workflow orchestrates retry with `retryable` hints
- [x] Cap in-run retries at configurable default (3 attempts per record) (plan: Retry Policy) — added `maxTransientAttemptsPerRecord` policy setting with default 3 and safety clamp
- [x] Map transient failures to `deferred_transient` outcome, terminal to `failed_terminal` (plan: Outcome Taxonomy) — exhausted transient attempts now end as `deferred_transient`; terminal path remains `failed_terminal`
- [x] Update workflow result tracking to include new outcome classes (plan: Outcome Taxonomy) — Chunk 1 counters retained; Chunk 3 retry flow now feeds those counters accurately

### Chunk 4: Cross-Run Bounded Retry

- [x] Persist retry metadata (`attempt_count`, `next_retry_at`, `last_error`, `last_error_kind`, `policy_lane`) on `deferred_transient` outcomes (plan: Retry Policy) — workflow now persists deferred transient metadata via activity (`recordTransientEnrichFailure`) with lane + error classification
- [x] Add cross-run retry selection: query retryable records by lane with `attempt_count < 6` and `next_retry_at <= now` (plan: Retry Policy > Cross-run transient retry) — added lane-aware DB/query activity methods for due retries (`getRetryable*ByLane`, `getRetryable*`)
- [x] Integrate carryover retry records into enrich record source after current-run stubs (plan: Sync Run Selection Order) — stub source ordering now runs current-run stubs, then due same-lane retries, then same-lane carryover stubs
- [x] Promote to `failed_terminal` when `attempt_count` reaches cross-run cap (default 6) (plan: Retry Policy) — deferred transient outcomes are promoted after persisted attempt count reaches cap
- [x] Add backoff calculation for `next_retry_at` (exponential with jitter) (plan: Retry Policy) — deterministic cross-run backoff+jitter scheduling added before writing `next_retry_at`

### Chunk 5: Target-Driven Manual Enrich Inputs

- [x] Add target input options to `workflow start enrich`: `--tweet-id` repeatable and `--file` (plan: Scope > Manual target-driven enrich inputs) — CLI `workflow start` now supports repeatable `--tweet-id` collection and enrich-only `--file`
- [x] Introduce enrich-target mode contract: manual policy-driven runs require explicit targets (tweet IDs via args/file) (plan: Scope > Manual target-driven enrich inputs) — policy enrich now fails fast without targets unless running maintenance mode
- [x] Add `--file` option accepting a file path with tweet IDs (one per line) (plan: Scope > Manual target-driven enrich inputs) — file loader added with comment/blank-line skipping
- [x] Implement deterministic target set resolution: dedupe, validate, resolve before traversal (plan: Scope > Deterministic target set resolution) — target IDs are trimmed, validated, deduped, and lexicographically sorted before workflow start
- [x] Wire target set into `EnrichWorkflowInput` as explicit ID list (plan: Scope > Deterministic target set resolution) — new `tweetIds` workflow input field carries resolved targets
- [x] When targets provided, skip record source queries and use explicit set directly (plan: Scope > Deterministic target set resolution) — enrich record source now short-circuits to explicit target list mode (no DB query activities)
- [x] Reject full-dataset policy runs: if policy profile is explicitly selected and no targets provided, fail fast with a clear CLI error (plan: Decision Summary) — manual policy enrich now rejects no-target runs by contract
- [x] Keep maintenance modes separate: disallow combining target mode with `--retry-unavailable` or `--outdated` in one run (plan: Decision Summary) — guardrail added in `workflow start enrich`

### Chunk 6: Policy Registry Migration & Metrics

- [x] Wire manual enrich profile selection from registry JSON in `workflow start enrich` (plan: Policy Registry Integration Plan)
- [x] Add explicit `--policy <profile>` for `workflow start enrich` and validate profile existence against registry (plan: Policy Registry Integration Plan)
- [x] Move `ENRICH_*` policy env vars to registry JSON; keep non-policy env vars (plan: Configuration Direction)
- [x] Log policy identity (`profileName`, `policyLane`, snapshot hash) at workflow start (plan: Workflow and Policy Contract)
- [x] Clamp all policy settings against hardcoded safety bounds (plan: Workflow and Policy Contract)
- [x] Add per-outcome-class and per-lane metrics to workflow result and summary output (plan: Scope > Clear metrics per outcome class and lane)
- [x] Update tests to validate registry as policy source of truth (plan: Configuration Direction)

## Progress Log

### Session 1 - 2026-03-04

- Started task
- Plan: .project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md
- Beginning Chunk 1

### Session 2 - 2026-03-05

- Completed Chunk 1: Outcome Taxonomy & Retry Metadata Foundation
- Commits: d7e3803
- Updated enrich taxonomy to `deferred_transient` / `failed_terminal` / `skipped_budget` with new workflow counters
- Added retry metadata columns and migration/index support in tweet schema maintenance
- Validated with `pnpm exec tsc --noEmit` and targeted tests:
  - `pnpm vitest tests/temporal-enrich-workflow.test.ts tests/temporal-activities.test.ts tests/db.test.ts`

### Session 3 - 2026-03-05

- Completed Chunk 2: Policy Lane Wiring & Lane-Aware Record Selection
- Commits: a637bfb
- Lane-aware selection added across workflow source + DB query activities
- Sync child enrich and manual enrich invocations now set explicit policy lanes
- Added sync carryover selection ordering (current-run first, then bounded same-lane carryover)
- Added coverage in enrich/sync workflow tests for lane args and carryover ordering

### Session 4 - 2026-03-05

- Completed Chunk 3: In-Run Transient Retry with Error Classification
- Commits: 10baca5
- Added workflow-level transient retry loops with deterministic backoff in enrich pass logic (single + batch paths)
- Added configurable transient attempt cap (`maxTransientAttemptsPerRecord`, default 3)
- Updated activity/workflow classification to surface retryable semantics and terminal/transient mapping
- Expanded enrich workflow tests for transient retry success, retry cap exhaustion, and transient batch retry narrowing

### Session 5 - 2026-03-05

- Completed Chunk 4: Cross-Run Bounded Retry
- Commits: be6bd94
- Persisted deferred transient retry metadata (`attempt_count`, `next_retry_at`, `last_error`, `last_error_kind`, `policy_lane`) through workflow-owned metadata activity writes
- Added lane-scoped due-retry selection (`attempt_count < max`, `next_retry_at <= now`) and integrated it into enrich record-source ordering
- Added cross-run attempt cap handling: deferred transient outcomes promote to `failed_terminal` when cap is reached
- Added deterministic exponential backoff with jitter for cross-run `next_retry_at` scheduling
- Added/updated tests for retry selection, cap promotion, metadata writes, and carryover ordering

### Session 6 - 2026-03-05

- Completed Chunk 5: Target-Driven Manual Enrich Inputs
- Commits: 2f90747
- Added repeatable `--tweet-id` plus `--file` input path for `workflow start enrich` target mode
- Added deterministic target resolution (trim/validate/dedupe/sort) and explicit-target workflow input wiring
- Added target-mode contract + maintenance-mode separation guardrails
- Added explicit-target record source mode to skip DB query selection and process supplied IDs directly
- Expanded CLI/workflow tests for target mode, no-target rejection, and mode mixing validation

### Session 7 - 2026-03-05

- Completed Chunk 6: Policy Registry Migration & Metrics
- Commits: ec32b7a
- Wired `workflow start enrich` policy resolution through registry defaults and explicit `--policy` selection
- Added policy identity snapshot wiring (`policyProfileName`, `policySnapshotHash`) into workflow input, runtime state, logs, and progress output
- Moved policy env loading out of runtime config path; enrich policy startup defaults are now static and registry-driven at workflow start
- Added hard safety clamps across all policy knobs in workflow policy resolution
- Added structured metrics (`metrics.outcomes`, `metrics.lanes`) to enrich progress/result and printed summary lines in workflow status output
- Updated canonical registry defaults/profile values and expanded tests for registry source-of-truth and new policy/metrics behavior

### Session 8 - 2026-03-05

- Completed follow-up documentation and operationalization after Chunk 6
- Commits: 1ec5ea8, 63a5106, 301a295
- Removed stale `ENRICH_*` policy env references and aligned docs to registry-driven policy behavior
- Reorganized README enrichment section and clarified outcomes/usage flow
- Added ADR 028 for targeted manual policy execution and updated ADR 027 to match `config-default` fallback semantics
- Switched policy registry to local-file workflow with committed examples under `config/examples/`

## Checkpoint: After Chunk 1

**Date:** 2026-03-05
**Commits:** d7e3803

**Context for Resumption:**

- Enrich outcome taxonomy now includes `deferred_transient`, `failed_terminal`, and `skipped_budget`, and enrich workflow state/result/progress tracks them explicitly.
- `policyLane` constants are defined in shared enrich types and lane resolution is now present in the enrich workflow startup path.
- Tweets schema now includes retry metadata fields (`attempt_count`, `next_retry_at`, `last_error`, `last_error_kind`, `policy_lane`) with defaults and indexes (`idx_tweets_retry_due`, `idx_tweets_policy_lane`).
- Migration/ensure logic was expanded in `tweet-maintenance-repo.ts` with non-destructive `ALTER TABLE` checks for each retry metadata column.
- Tests updated for new enrich outcomes (`tests/temporal-enrich-workflow.test.ts`, `tests/temporal-activities.test.ts`, `tests/temporal-sync-history.integration.test.ts`) and DB retry metadata defaults (`tests/db.test.ts`).

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Policy Lane Affinity`
- `Sync Run Selection Order`
- `Retry Policy`

## Checkpoint: After Chunk 2

**Date:** 2026-03-05
**Commits:** a637bfb

**Context for Resumption:**

- `createEnrichRecordSource` now applies `policyLane` to all selection modes and implements sync carryover fallback after current-run stubs.
- Sync carryover constraints are code-defined in enrich workflow path: `50` records max and `30s` timebox.
- Query activity + DB repos now support lane-aware selection/count methods for stubs, unavailable records, and outdated records.
- Sync workflow now checks stubs in `sync.atomic` lane for child trigger/finalization decisions; child input explicitly carries `policyLane: sync.atomic`.
- Manual enrich CLI start resolves and passes explicit manual lane (`manual.atomic|origin|conversation|quotes`) based on effective policy mode.

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Policy Lane Affinity`
- `Sync Run Selection Order`

## Checkpoint: After Chunk 3

**Date:** 2026-03-05
**Commits:** 10baca5

**Context for Resumption:**

- Enrich workflow pass now performs in-run transient retries for both single-record and batch enrich paths.
- Retry orchestration is workflow-owned: transient errors pause/backoff in workflow, activities remain single-pass without internal retry loops.
- Per-record retry cap is policy-configurable via `maxTransientAttemptsPerRecord` (default 3, clamped).
- Thrown/runtime errors are classified transient vs terminal using status/keyword heuristics; exhausted transient attempts finalize as `deferred_transient`.
- `enrichRecord` activity now classifies fetch errors as retryable vs terminal and surfaces `retryable` + `error` metadata to workflow.
- Test coverage added for:
  - transient single-record retry then success
  - transient single-record retry cap exhaustion
  - transient batch retry narrowing to remaining transient IDs

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Retry Policy > In-run transient retry`
- `Outcome Taxonomy`

## Checkpoint: After Chunk 4

**Date:** 2026-03-05
**Commits:** be6bd94

**Context for Resumption:**

- Deferred transient outcomes now persist retry metadata through a dedicated activity write path, including attempt count, due time, last error data, and lane affinity.
- Stub selection now excludes scheduled retry rows; due retries are selected explicitly by lane via `attempt_count < cap` and `next_retry_at <= now`.
- Enrich record source ordering for stubs is now: current-run stubs, due same-lane retries, then same-lane carryover stubs (bounded by existing sync carryover cap/timebox).
- Cross-run retry cap is enforced in workflow outcome handling: persisted attempts reaching cap are promoted from `deferred_transient` to `failed_terminal`.
- Cross-run retry scheduling now uses deterministic exponential backoff plus stable jitter keyed by tweet ID and attempt number.
- Tests updated and passing for workflow, activity, and DB-level retry behavior (`pnpm exec tsc --noEmit`, `pnpm vitest`).

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Retry Policy > Cross-run transient retry`
- `Sync Run Selection Order`

## Checkpoint: After Chunk 5

**Date:** 2026-03-05
**Commits:** 2f90747

**Context for Resumption:**

- `workflow start enrich` now accepts explicit target inputs via repeatable `--tweet-id` and `--file` (one ID per line).
- Manual policy enrich runs require explicit targets unless running maintenance mode (`--retry-unavailable` or `--outdated`); incompatible mode combinations are rejected.
- Target resolution is deterministic before workflow start: IDs are trimmed, validated for one-per-line/no-whitespace format, deduped, and sorted.
- `EnrichWorkflowInput` now includes `tweetIds`; workflow record sourcing short-circuits to explicit targets when provided and skips DB source queries.
- Engagement tracking keeps single-ID semantics by validating `--tweet-id` cardinality in shared polling workflow start helper.
- Tests updated and passing for CLI routing, workflow explicit-target behavior, and shared start-handler parsing (`pnpm exec tsc --noEmit`, `pnpm vitest`).

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Scope > Manual target-driven enrich inputs`
- `Scope > Deterministic target set resolution`

## Checkpoint: After Chunk 6

**Date:** 2026-03-05
**Commits:** ec32b7a

**Context for Resumption:**

- `workflow start enrich` now resolves policy from the registry path (`config/enrichment-policy-profiles.v1.json` by default) and supports explicit profile selection via `--policy`.
- Manual enrich workflow input now carries policy identity fields (`policyProfileName`, `policySnapshotHash`) alongside lane and policy config.
- Enrich workflow runtime logs include policy identity (`policyProfileName`, `policySnapshotHash`, `policyLane`) at start/completion/failure.
- Workflow policy resolution now clamps every policy setting against hardcoded safety bounds before execution.
- Enrich progress/result now expose structured metrics (`metrics.outcomes` + `metrics.lanes`) in addition to top-level counters, and status output renders these summaries.
- Runtime config no longer consumes policy `ENRICH_*` env vars for enrich behavior; policy source-of-truth is registry/default profile selection at workflow start.
- Tests updated and passing for config, registry contract/loading, policy selection, workflow start routing, and enrich workflow metrics/policy identity (`pnpm exec tsc --noEmit`, `pnpm vitest`).

**Plan Reference:**

See plan file at **Plan:** `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`, sections:

- `Policy Registry Integration Plan`
- `Configuration Direction`
- `Workflow and Policy Contract`

## Feedback

## Action Items

## Notes

- `.project` plan/task artifacts updated as local workflow records and are not part of committed source history.
