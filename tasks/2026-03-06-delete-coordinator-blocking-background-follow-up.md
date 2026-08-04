# Task: Delete Coordinator Blocking + Background Follow-up

**Status:** Complete
**Created:** 2026-03-06
**Related Plan:** .project/plans/2026-03-05-delete-coordinator-workflow.md
**Related ADR:** docs/adr/031-delete-coordinator-workflow.md
**Ref:** 9501a6
**Source:** Follow-up after Stage 2 coordinator extraction and Sync Orchestrator landing

## Goal

Promote the Delete Coordinator from a shared inline interface to real runtime behavior:

- folder sync can request `blocking` delete work when pagination depends on deletes finishing
- no-folder sync can use `background` delete work when fetch/store can keep moving
- suspicious no-folder terminal pages can still escalate to delete-reveal behavior when needed

## Non-Goals

- Do not redesign fairness/preemption beyond the current simple model.
- Do not solve multi-sync arbitration in the same pass.
- Do not fold proactive no-folder fetch shaping into this task.
- Do not change `folder_id IS NULL` delete scope semantics unless implementation proves it is necessary.

## Decisions

- No-folder sync uses `background` delete mode by default after store succeeds.
- No-folder sync may temporarily escalate to `blocking` delete mode when delete-reveal is needed to recover from a suspicious terminal page.
- Folder sync continues to use `blocking` delete mode because delete completion is part of pagination progress.
- The runtime owner should be a singleton **DeleteCoordinatorWorkflow**, not per-sync child delete workflows and not an activity-backed lane.
- Background delete visibility should live on its own workflow surface (`workflow status delete-coordinator`), not be forced into sync/orchestrator status for the first pass.
- Simple priority only for the first pass:
  - `blocking` work outranks `background` work
  - folder-sync blocking delete can jump ahead of no-folder background delete
  - no fairness system beyond that yet

## Chunks

### Chunk 1: Runtime contract

- [x] Create the concrete Stage 3 contract around a singleton `DeleteCoordinatorWorkflow`
- [x] Define the submission/wait surface between sync workflow and delete coordinator:
  - `background` submit returns after the job is accepted
  - `blocking` submit waits until the requested delete work is complete (or fails/cancels)
- [x] Define job shape and status shape clearly enough for both folder and no-folder callers:
  - scope
  - source (`backlog` vs `current-batch`)
  - mode (`blocking` vs `background`)
  - counts / progress / rate-limit state
- [x] Define the simple first-pass priority rule:
  - blocking jobs ahead of background jobs
  - folder-sync blocking deletes allowed to preempt no-folder background work
- [x] Preserve the current live no-folder delete-reveal fallback as a first-class requirement

### Chunk 2: Background delete execution

- [x] Introduce the dedicated `DeleteCoordinatorWorkflow`
- [x] Route normal no-folder post-store delete handoff through `background` submission
- [x] Keep folder sync behavior effectively `blocking`
- [x] Preserve backlog-before-fetch and current-batch-after-store lifecycle positions even though execution ownership moves out of the inline engine
- [x] Keep `--no-delete` semantics unchanged

### Chunk 3: No-folder escalation behavior

- [x] Let no-folder sync run without waiting on delete in the normal case
- [x] Escalate back to `blocking` delete when a suspicious terminal page needs reveal-after-delete
- [x] Ensure the escalation path waits only when needed instead of turning normal no-folder sync back into a fully blocking delete flow
- [x] Verify the `limit=100 -> 94 + restart` path still works live or in workflow regression coverage

### Chunk 4: Verification and docs

- [x] Add focused workflow/integration coverage for blocking and background modes
- [x] Add CLI status support for the coordinator itself:
  - `workflow status delete-coordinator`
  - active job
  - queue length
  - current mode
  - current scope
  - pending/progress counts
  - next rate-limit reset when applicable
- [x] Keep sync/orchestrator status lightweight in the first pass; do not try to embed full background delete detail there
- [x] Update README / ADR 031 / relevant issue docs as needed

## Notes

- Stage 2 is already complete in `.project/tasks/2026-03-06-delete-coordinator-workflow.md`.
- "Fetch shaping" stays out of scope here on purpose. If we later pursue it, it means proactively changing no-folder request sizes or slicing large limits to avoid known API oddities before fallback is needed.
- Fairness/preemption beyond simple `blocking > background` priority is still out of scope for the first blocking/background implementation.
- This task should stay focused on delete ownership, blocking/background behavior, and status visibility for the coordinator itself.
- Current shipped scope is intentionally narrower than the long-term model:
  - no-folder current-batch delete can use the coordinator
  - folder sync delete still runs inline
  - backlog-before-fetch delete still runs inline
- Future exploration:
  - route folder-sync blocking delete through the coordinator too
  - route backlog delete through the coordinator so all Temporal delete ownership lives in one place
  - revisit whether active background work ever needs true preemption instead of simple queue ordering

## Progress Log

### Session 1 - 2026-03-06

- Completed Chunk 1
- Added shared Stage 3 contract types in `src/temporal/shared/delete-coordinator-types.ts`:
  - singleton workflow ID: `delete-coordinator`
  - job shape
  - completion target for blocking callers
  - completion signal payload
  - workflow input/result/progress types
- Re-exported the new contract types from `src/temporal/shared/types.ts`
- Added queue/signals/state/handler scaffolding for the future workflow runtime:
  - `src/temporal/workflows/delete-coordinator/queue.ts`
  - `src/temporal/workflows/delete-coordinator/signals.ts`
  - `src/temporal/workflows/delete-coordinator/state.ts`
  - `src/temporal/workflows/delete-coordinator/handlers.ts`
- Added re-export surface in `src/temporal/workflows/delete-coordinator.ts` and top-level exports in `src/temporal/workflows/index.ts`
- Contract decisions now encoded in code:
  - background jobs are accepted without waiting
  - blocking jobs can carry a completion target so the coordinator can signal the waiting sync workflow back later
  - queue ordering is simple `blocking > background` with FIFO inside each mode
  - no dedup is applied at the job queue layer in the first pass
- Added unit coverage in `tests/delete-coordinator-queue.test.ts` for:
  - blocking ahead of background
  - FIFO within the same mode
  - accepting repeated jobs without dedup
- Verification:
  - `pnpm test tests/delete-coordinator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: the Stage 3 contract is now explicit and test-backed; next chunk is the actual dedicated background delete runtime path

### Session 2 - 2026-03-06

- Completed Chunk 2
- Added the dedicated Temporal workflow runtime:
  - `src/temporal/workflows/delete-coordinator/activities.ts`
  - `src/temporal/workflows/delete-coordinator/index.ts`
- The workflow now:
  - accepts queued delete jobs
  - runs them sequentially through the existing inline coordinator logic
  - uses the existing delete/backlog/verify/retry activity surfaces instead of re-implementing delete behavior
  - keeps simple queue semantics: `blocking` ahead of `background`, FIFO within each mode
- Added sync-side submission helper:
  - `src/temporal/workflows/sync/delete-coordinator-orchestrator.ts`
- Wired Temporal no-folder sync to use background delete handoff only for the normal post-store case:
  - `src/temporal/workflows/sync/index.ts`
  - `src/temporal/workflows/sync/page-runner.ts`
- Current runtime shape after this chunk:
  - folder sync still deletes inline/blocking
  - backlog-before-fetch still stays inline/blocking
  - `--no-delete` still keeps the old semantics
  - no-folder current-batch delete is handed to the singleton coordinator only when the page still has a `nextToken`
  - if coordinator submission fails, sync falls back to the old inline delete path
  - suspicious/terminal no-folder pages still stay inline for now; the smarter escalation rule is the next chunk
- Important nuance:
  - once a no-folder page is handed off to background delete, the sync workflow's own `deleted` counter/result reflects only inline deletes completed inside the sync run
  - the handed-off background work is now owned by the coordinator workflow instead
- Updated regression coverage in `tests/temporal-sync-workflow.test.ts` to match the new background handoff behavior for the recovered `limit=100` path
- Verification:
  - `pnpm test tests/temporal-sync-workflow.test.ts tests/delete-coordinator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: the dedicated background delete runtime path exists and Temporal no-folder sync can now hand off normal current-batch deletes to it; next chunk is the no-folder escalation rule so delete-reveal only blocks when it truly needs to

### Session 3 - 2026-03-07

- Completed Chunk 3
- Added sync-side completion handling for blocking coordinator jobs:
  - `src/temporal/workflows/sync/handlers.ts`
  - `src/temporal/workflows/sync/index.ts`
  - `src/temporal/workflows/sync/delete-coordinator-orchestrator.ts`
- Added coordinator completion signaling back to the waiting sync workflow:
  - `src/temporal/workflows/delete-coordinator/index.ts`
- Updated no-folder delete mode selection in `src/temporal/workflows/sync/page-runner.ts`:
  - normal no-folder current-batch pages stay background
  - suspicious terminal full-data pages escalate to coordinator-backed `blocking`
  - terminal pages that already satisfy the requested limit do not force blocking reveal waits
- Preserved the existing inline fallback if coordinator submission fails
- Updated workflow regression coverage in `tests/temporal-sync-workflow.test.ts` so the recovered `limit=100` path now proves:
  - the first `94`-item terminal page is submitted as a blocking coordinator job
  - the sync waits for delete completion
  - the cursor loop restarts and fetches the remaining `6`
- Verification:
  - `pnpm test tests/temporal-sync-workflow.test.ts tests/delete-coordinator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: the no-folder escalation rule is now real and regression-covered; next chunk is coordinator status visibility plus broader blocking/background workflow coverage

### Session 4 - 2026-03-07

- Completed Chunk 4
- Added dedicated coordinator status rendering and control support:
  - `src/commands/workflow/status-command/progress.ts`
  - `src/commands/workflow/control.ts`
  - `src/commands/workflow/shared.ts`
- `workflow status delete-coordinator` now shows:
  - active job
  - queue length and queue detail
  - current mode and source
  - scope
  - current processed/deleted/failed counts
  - next rate-limit reset
- Kept sync and sync-orchestrator status surfaces lightweight; detailed background delete visibility stays on the dedicated coordinator workflow surface
- Added workflow/unit coverage:
  - `tests/delete-coordinator-workflow.test.ts`
  - `tests/workflow-status-progress.test.ts`
- Updated docs:
  - `README.md`
  - `docs/adr/031-delete-coordinator-workflow.md`
  - `CLAUDE.md`
- Verification:
  - `pnpm test tests/delete-coordinator-workflow.test.ts tests/workflow-status-progress.test.ts tests/temporal-sync-workflow.test.ts tests/delete-coordinator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: first-pass blocking/background delete coordinator work is complete; future work now narrows to preemption/fairness policy, deeper status ergonomics if needed, and fetch-shaping experiments kept out of scope here
