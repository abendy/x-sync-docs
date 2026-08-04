# Task: Delete Coordinator Full Ownership

**Status:** Complete
**Created:** 2026-03-07
**Related Plan:** .project/plans/2026-03-05-delete-coordinator-workflow.md
**Related ADR:** docs/adr/031-delete-coordinator-workflow.md
**Source:** Follow-up after Stage 3 landed with mixed inline + coordinator delete execution

## Goal

Collapse Temporal delete execution into one obvious model:

- backlog-before-fetch delete goes through the singleton `DeleteCoordinatorWorkflow`
- folder current-batch delete goes through the singleton `DeleteCoordinatorWorkflow`
- no-folder current-batch delete keeps using the coordinator in `background` or `blocking` mode as already designed

The result should be: in Temporal sync, delete ownership lives in one place.

## Non-Goals

- Do not redesign fairness or active-job preemption in this pass.
- Do not change `--no-delete` semantics.
- Do not fold fetch-shaping work into this task.
- Do not rewrite local sync around the workflow coordinator.

## Decisions

- Backlog delete should use coordinator-backed `blocking` execution.
- Folder current-batch delete should use coordinator-backed `blocking` execution.
- No-folder current-batch delete keeps the current split:
  - normal pages -> `background`
  - suspicious terminal reveal pages -> `blocking`
- If coordinator submission/completion fails, Temporal sync may still fall back to inline delete as a safety backstop.
- True active preemption is still deferred:
  - queued `blocking` jobs outrank queued `background` jobs
  - but this pass does not interrupt an already running background job

## Chunks

### Chunk 1: Tracking + runtime seam

- [x] Add the task doc and capture the scope clearly
- [x] Add the minimal runtime seam needed so Temporal sync can skip inline backlog delete and own delete orchestration in the page runner instead

### Chunk 2: Backlog ownership

- [x] Route backlog-before-fetch through the delete coordinator in `blocking` mode
- [x] Preserve backlog result accounting in sync state/result
- [x] Preserve existing cancel / failure fallback behavior

### Chunk 3: Folder current-batch ownership

- [x] Route folder current-batch delete through the delete coordinator in `blocking` mode
- [x] Keep no-folder delete mode selection unchanged except for sharing the same coordinator path
- [x] Keep `--no-delete` enqueue-only behavior unchanged

### Chunk 4: Verification

- [x] Update workflow regressions for:
  - folder sync delete going through the coordinator
  - backlog delete going through the coordinator
  - recovered no-folder `limit=100 -> 94 + restart` path still working
- [x] Run focused tests and `pnpm typecheck`

## Result

- Temporal sync now routes delete-enabled backlog work through the singleton `DeleteCoordinatorWorkflow` in `blocking` mode.
- Temporal sync now routes delete-enabled folder current-batch work through the singleton `DeleteCoordinatorWorkflow` in `blocking` mode.
- Temporal sync now routes all delete-enabled no-folder current-batch work through the coordinator too:
  - normal pages -> `background`
  - suspicious terminal reveal pages -> `blocking`
- Inline delete is now just the safety fallback when coordinator submit/wait fails.

## Verification

- `pnpm test tests/temporal-sync-workflow.test.ts tests/delete-coordinator-workflow.test.ts`
- `pnpm test tests/temporal-orchestrator-workflow.test.ts`
- `pnpm typecheck`

## Notes

- This task is about making the Delete Coordinator the obvious Temporal runtime owner for delete work.
- It does **not** try to solve the later question of whether blocking jobs should interrupt an already running background delete job.
- That means folder sync may still wait behind an active background delete job, even after delete ownership is unified here.
