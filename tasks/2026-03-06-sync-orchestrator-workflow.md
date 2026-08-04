# Task: Sync Orchestrator Workflow

**Status:** Complete
**Created:** 2026-03-06
**Plan:** .project/plans/2026-02-19-sync-orchestrator-workflow.md

## Workflow Rules (do not remove)

- Use `/commit` after completing each chunk (not raw git commit)
- Mark completed tasks with `[x]` in this file after each chunk
- Generate chunk boundary report after each chunk
- Stop and wait for review after each chunk
- Do not batch work across chunks

## Chunks

### Chunk 1: Foundation — shared types, priority queue, queue tests

- [x] Create `src/temporal/shared/orchestrator-types.ts` with `SyncPriority`, `SyncRequest`, `SyncOrchestratorWorkflowInput`, `SyncOrchestratorWorkflowResult`, `SyncOrchestratorProgress`, `EnqueueSyncSignalPayload`, `GetKnownFoldersOutput` (plan: Step 1)
- [x] Define and document a canonical queue key / merge policy that covers folder-vs-no-folder intent and flags (`folderId`, `noFolders`, `noDelete`, `pages`, `limit` where applicable) so semantically distinct requests are not merged accidentally (plan: Feedback #3)
- [x] Re-export from `src/temporal/shared/types.ts` (plan: Step 1)
- [x] Create `src/temporal/workflows/orchestrator/queue.ts` — pure priority queue with `enqueue` (dedup/promote), `dequeue`, `peek`, `contains`, `promote`, `remove`, `toArray`, `size`; address review feedback #3 by defining canonical dedup key that accounts for `noDelete`/`noFolders`/`pages` alongside `folderId` (plan: Step 2, Feedback #3)
- [x] Create `tests/orchestrator-queue.test.ts` — priority ordering, dedup by key, promote on higher priority, ignore lower, merge policy for differing request flags (plan: Step 2, Feedback #3)

### Chunk 2: Activities and workflow internals

- [x] Add `getKnownFolders()` activity to `src/temporal/activities/query.ts` (plan: Step 3)
- [x] Add `cacheFolders()` activity to `src/temporal/activities/store.ts` (plan: Step 3, Feedback — architecture layering: writes go in store.ts)
- [x] Create `src/temporal/workflows/orchestrator/signals.ts` — `enqueueSyncSignal`, `startWatchSignal`, `stopWatchSignal`, `pauseSignal`, `resumeSignal`, `cancelSignal`, `progressQuery` (plan: Step 4)
- [x] Create `src/temporal/workflows/orchestrator/activities.ts` — proxy for `fetchFolders`, `getKnownFolders`, `cacheFolders` (plan: Step 4)
- [x] Create `src/temporal/workflows/orchestrator/state.ts` — `OrchestratorRuntimeState` and factory (plan: Step 4)
- [x] Create `src/temporal/workflows/orchestrator/handlers.ts` — `registerOrchestratorHandlers()` wiring signals/queries (plan: Step 4)

### Chunk 3: Main workflow implementation

- [x] Create `src/temporal/workflows/orchestrator/index.ts` — main loop: watch refresh, pause check, continue-as-new, dequeue/child/await, watch timer (plan: Step 5)
- [x] Use `ParentClosePolicy.REQUEST_CANCEL` (not ABANDON) for child SyncWorkflow to prevent orphaned deletes (plan: Step 5, Feedback #2)
- [x] Implement `refreshFolderQueue()` — fetchFolders (handle pagination if present), cacheFolders, getKnownFolders, enqueue fresh/stale (plan: Step 5, Feedback #5)
- [x] Implement continue-as-new with full carry-forward: queue snapshot, counters, watch state, `lastFolderRefreshAt`, control flags (plan: Step 5, Feedback #4)
- [x] Define orchestrator control semantics explicitly in workflow code: whether pause/resume/cancel apply only to queue scheduling or also propagate to the active child sync (plan: Feedback — clarify control semantics)
- [x] Create `src/temporal/workflows/orchestrator.ts` re-export hub (plan: Step 5)
- [x] Add orchestrator exports to `src/temporal/workflows/index.ts` with prefixed aliases (plan: Step 5)
- [x] Export `ORCHESTRATOR_WORKFLOW_ID` from shared module consumed by both workflow and CLI (plan: Step 5, Feedback — singleton ID drift)

### Chunk 4: CLI integration — start, routing, control, status

- [x] Add `'sync-orchestrator'` to `WorkflowKind` in `src/commands/workflow/shared.ts` and extend `WORKFLOW_LIST_QUERY` so status/list surfaces can see it (plan: Step 6)
- [x] Add `watch?: boolean` to `src/commands/workflow/start-command/types.ts` so orchestrator start plumbing is typed end-to-end (plan: Step 6)
- [x] Add `--watch` option to start command registration (plan: Step 6)
- [x] Create `src/commands/workflow/start-command/sync-orchestrator.ts` start handler (plan: Step 6)
- [x] Add orchestrator handler to `start-command/handlers.ts` and ensure unknown-workflow errors mention it (plan: Step 6)
- [x] Modify `src/commands/sync/bookmarks/temporal.ts` to use `signalWithStart` for atomic enqueue/start (plan: Step 7, Feedback #1)
- [x] Add `--watch` and `--watch-interval <minutes>` to sync bookmarks CLI with strict positive-integer parsing and bounds/defaults across `register.ts`, `types.ts`, and `options.ts`, and pass the resolved values into orchestrator start/signal payloads (plan: Step 7, Feedback #6)
- [x] Add orchestrator pause/resume/cancel to `src/commands/workflow/control.ts` with documented semantics (plan: Step 8, Feedback — clarify control semantics)
- [x] Add `renderOrchestratorProgress()` to `src/commands/workflow/status-command/progress.ts` (plan: Step 8)

### Chunk 5: Workflow tests

- [x] Create `tests/temporal-orchestrator-workflow.test.ts` following `temporal-sync-workflow.test.ts` pattern — `vi.hoisted()` mocks, `vi.mock('@temporalio/workflow')` (plan: Step 9)
- [x] Add automated workflow coverage for single request processing, priority ordering, watch mode timer, and enqueue signal during idle (plan: Step 9)
- [x] Add automated workflow coverage for pause/resume, cancel, continue-as-new trigger with non-empty queue, and child failure handling (plan: Step 9, Feedback #4)
- [x] Add automated CLI-routing coverage showing concurrent `sync` invocations use atomic enqueue/start (plan: Feedback #1)
- [x] Add automated workflow coverage for cancelling the orchestrator while a child is active, then restarting without overlap (plan: Feedback #2)
- [x] Add automated queue/workflow coverage for same-folder requests with different execution flags (plan: Feedback #3)
- [x] Add automated workflow coverage for folder refresh pagination via `nextToken` so multi-page refresh does not silently truncate watch-mode input (plan: Feedback #5)
- [x] Add automated CLI parsing coverage for `--watch-interval`, including invalid/edge values rejected cleanly (plan: Feedback #6)

### Chunk 6: Documentation

- [x] Create `docs/adr/032-sync-orchestrator-workflow.md` — problem (global delete + concurrent sync), decision (singleton + priority queue + watch), consequences; clarify control semantics for pause/resume/cancel vs child (plan: Step 10, Feedback — ADR control semantics)

### Chunk 6a: Deferred follow-up — watch + priority command model

- [x] Track follow-up work in `.project/tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md`
- [x] Follow-up scope:
  - add `--next` for urgent enqueue
  - make `--watch` mean repeating sync by request shape
  - remove the need for a separate user-facing `workflow start sync-orchestrator` start step

### Chunk 7: Verification

- [x] Run queue tests: `vitest run tests/orchestrator-queue.test.ts` (plan: Verification)
- [x] Run orchestrator workflow tests: `vitest run tests/temporal-orchestrator-workflow.test.ts` (plan: Verification)
- [x] Run lint + typecheck (plan: Verification)
- [x] Run manual E2E with Temporal dev server / worker: start orchestrator, enqueue urgent sync, inspect status, test watch mode, and exercise pause/resume/cancel semantics (plan: Verification)
- [x] Confirm no-folder API-oddity experiments were not silently pulled into orchestrator behavior during this task (plan: API oddities guardrail)

## Progress Log

### Session 1 - 2026-03-06

- Created task from plan
- Plan: .project/plans/2026-02-19-sync-orchestrator-workflow.md
- Plan has 10 implementation steps, chunked into 6 execution chunks
- Review feedback (2026-02-21) threaded into relevant chunks as must-fix items
- Review update: added missing task coverage for `StartOptions.watch`, `WORKFLOW_LIST_QUERY`, full `--watch-interval` plumbing, control-semantics definition, and folder-refresh pagination tests
- Review update: keep API-oddity fetch-shaping ideas exploratory; this task should serialize sync requests, not proactively rewrite no-folder page sizing policy
- Review update: added an explicit verification chunk so the implementation closes with queue tests, workflow tests, lint/typecheck, and manual orchestrator E2E

### Session 2 - 2026-03-06

- Completed Chunk 1
- Added `src/temporal/shared/orchestrator-types.ts`
- Added `src/temporal/workflows/orchestrator/queue.ts`
- Added `tests/orchestrator-queue.test.ts`
- Re-exported orchestrator shared types from `src/temporal/shared/types.ts`
- Canonical queue-key / merge-policy decision:
  - identity is based on resolved execution shape, not queue metadata
  - dedup key includes `folderId`, `noFolders`, `noDelete`, `pages`, and `limit`
  - `priority` and `requestedAt` affect ordering only, not identity
  - same-key requests promote only when the new request has higher priority; equal/lower priority requests are ignored
  - promotion preserves the earliest `requestedAt` so ordering within a priority band stays deterministic
- Verification:
  - `pnpm test tests/orchestrator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: shared orchestrator types and pure queue behavior are in place; next chunk is workflow internals (activities, signals, state, handlers)

### Session 3 - 2026-03-06

- Completed Chunk 2
- Added orchestrator workflow internals:
  - `src/temporal/workflows/orchestrator/signals.ts`
  - `src/temporal/workflows/orchestrator/activities.ts`
  - `src/temporal/workflows/orchestrator/state.ts`
  - `src/temporal/workflows/orchestrator/handlers.ts`
- Added orchestrator activity types to `src/temporal/shared/activity-types.ts`:
  - `FetchFoldersOutput`
  - `CacheFoldersInput`
  - `OrchestratorActivities`
- Added `getKnownFolders()` read activity to `src/temporal/activities/query.ts`
- Added `cacheFolders()` write activity to `src/temporal/activities/store.ts`
- Handler/shape decisions:
  - enqueue payloads default to `priority: 'urgent'`
  - enqueue handler fills `requestedAt` with workflow-provided `nowIso()` when absent
  - watch toggles are handled independently of pause/resume
  - progress query returns queue snapshot, current request/child, counters, watch config, and derived status from runtime state + queue size
- State-shape note:
  - runtime state now carries `isPaused`, `isCancelled`, `isComplete`, `watchEnabled`, `watchIntervalMs`, `currentRequest`, `currentChildWorkflowId`, counters, and last-error/refresh metadata
  - `resolveOrchestratorStatus(...)` is centralized in `state.ts` so later workflow logic and CLI query rendering share one status interpretation
- Verification:
  - `pnpm test tests/orchestrator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: activities, signals, state, and handlers are ready; next chunk is the main workflow loop plus exports and shared singleton-ID wiring

### Session 4 - 2026-03-06

- Completed Chunk 3
- Added `src/temporal/workflows/orchestrator/index.ts`
- Added `src/temporal/workflows/orchestrator.ts` re-export hub
- Updated `src/temporal/workflows/index.ts` with prefixed orchestrator exports
- Added shared orchestrator constants to `src/temporal/shared/orchestrator-types.ts`:
  - `ORCHESTRATOR_WORKFLOW_ID`
  - `CONTINUE_AS_NEW_THRESHOLD`
  - `DEFAULT_WATCH_INTERVAL_MS`
- Expanded folder-refresh surface to support pagination:
  - `src/temporal/shared/activity-types.ts` adds `FetchFoldersInput`
  - `src/temporal/activities/fetch.ts` now accepts optional `paginationToken`
  - `src/sources/types.ts` and `src/sources/x-api.ts` now pass folder pagination tokens through
- Main workflow behavior now implemented:
  - initial watch-mode refresh when queue is empty
  - dequeue → child `SyncWorkflow` start → await result → continue loop
  - watch-mode idle wait with timed refresh
  - continue-as-new after threshold with queue snapshot + counters + watch state + pause flag carry-forward
- Control semantics are now explicit in workflow code:
  - pause/resume affect both orchestrator scheduling and the active child sync
  - cancel stops new scheduling, forwards cancel to the active child, and exits after the active child completes/cancels
- Child workflow safety:
  - uses `ParentClosePolicy.REQUEST_CANCEL`
  - child failures record `lastError` and do not automatically abort the whole orchestrator loop
- Refresh behavior:
  - fetches all folder pages by following `nextToken`
  - caches API folders
  - enqueues API folders as `fresh`
  - enqueues DB-only folders as `stale`
- Verification:
  - `pnpm test tests/orchestrator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: the orchestrator runtime loop and exports are in place; next chunk is CLI integration (start/routing/control/status) so the workflow becomes reachable from user-facing commands

### Session 5 - 2026-03-06

- Completed Chunk 4
- Added CLI workflow-type plumbing:
  - `src/commands/workflow/shared.ts` now includes `sync-orchestrator` in both `WorkflowKind` and `WORKFLOW_LIST_QUERY`
  - `src/commands/workflow/start-command/types.ts` now carries `watch?: boolean`
  - `src/commands/workflow/start-command/register.ts` now exposes `--watch`
  - `src/commands/workflow/start-command/sync-orchestrator.ts` starts the singleton orchestrator with fixed workflow ID
  - `src/commands/workflow/start-command/handlers.ts` now routes `sync-orchestrator`
- Routed `sync` bookmarks Temporal execution through the orchestrator:
  - `src/commands/sync/bookmarks/temporal.ts` now uses `signalWithStart(...)` against `ORCHESTRATOR_WORKFLOW_ID`
  - direct sync requests are enqueued atomically with urgent priority
  - watch-only mode (`pnpm dev sync --watch`) now starts/enables the orchestrator without requiring a folder argument
  - watch-enabled sync requests now enqueue atomically, then signal watch mode separately so an already-running orchestrator can enable/update watch behavior
- Extended sync bookmarks CLI option plumbing:
  - `src/commands/sync/bookmarks/register.ts` adds `--watch` and `--watch-interval <minutes>`
  - `src/commands/sync/bookmarks/types.ts` / `options.ts` now carry resolved watch state end-to-end
  - watch interval parsing is strict positive-integer with bounds checks and default resolution
  - `--watch` is rejected with `--dry-run` and `--local`
- Preserved existing sync behavior that would otherwise regress during orchestration:
  - orchestrator queue requests now carry `resume`
  - orchestrated child sync inputs now carry configured `mediaDir`
  - queue canonical key now includes `resume`
  - `startWatchSignal` now accepts optional watch-interval payload so a running orchestrator can adopt a new interval
- Added user-facing control/status surfaces:
  - `src/commands/workflow/control.ts` now supports orchestrator pause/resume/cancel with explicit singleton semantics in output
  - `src/commands/workflow/status-command/progress.ts` now renders orchestrator progress, watch state, queue contents, active child, refresh timing, and last error
- Updated focused tests:
  - `tests/orchestrator-queue.test.ts` now covers `resume` as part of request identity
  - `tests/sync-command-routing.test.ts` now verifies orchestrator routing, watch mode, watch-only start, and `workflow start sync-orchestrator`
- Verification:
  - `pnpm test tests/orchestrator-queue.test.ts tests/sync-command-routing.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: CLI integration is wired end-to-end; next chunk is dedicated orchestrator workflow tests

### Session 6 - 2026-03-06

- Completed Chunk 5
- Added `tests/temporal-orchestrator-workflow.test.ts` with a focused mocked workflow harness using `vi.hoisted()` and `vi.mock('@temporalio/workflow')`
- New orchestrator workflow coverage includes:
  - single queued request processing
  - priority ordering across queued requests
  - distinct same-folder requests when execution flags differ
  - watch-mode timeout refresh behavior
  - enqueue signal while idle in watch mode
  - paused-start resume path
  - cancel while child is active, then clean restart in a later run
  - continue-as-new with carried queue/watch state
  - child failure handling without aborting the whole orchestrator
  - folder refresh pagination using `nextToken`
- Expanded CLI routing coverage in `tests/sync-command-routing.test.ts`:
  - concurrent `sync` invocations both use atomic `signalWithStart(...)`
  - out-of-range `--watch-interval` values are rejected cleanly
- Existing queue coverage in `tests/orchestrator-queue.test.ts` remains the source of truth for canonical dedup/merge behavior, including same-folder requests with different execution flags
- Verification:
  - `pnpm test tests/temporal-orchestrator-workflow.test.ts tests/orchestrator-queue.test.ts tests/sync-command-routing.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: orchestrator workflow behavior is now covered at the unit level; next chunk is documentation (ADR + CLI docs)

### Session 7 - 2026-03-06

- Completed Chunk 6
- Added `docs/adr/032-sync-orchestrator-workflow.md`
  - captures the concurrency problem (global delete side effects + shared delete bucket)
  - records the singleton orchestrator decision, queue policy, atomic `signalWithStart(...)` routing, and explicit pause/resume/cancel control semantics
  - documents the boundary between orchestration and delete coordination
- Updated `docs/adr/README.md` to index ADR 032
- Updated `README.md` so user-facing docs match current behavior:
  - `pnpm dev sync ...` is documented as the default orchestrator-backed path
  - watch mode commands are documented
  - `workflow start sync-orchestrator --watch` is documented explicitly
  - `workflow start sync --folder ...` is documented as the explicit workflow-command form of the same orchestrated request path
- Updated `CLAUDE.md`:
  - workflow command examples now show both `sync` and `workflow start sync` as orchestrator-backed sync entrypoints
  - SyncOrchestratorWorkflow entry now documents fixed workflow ID and child-control semantics
- Updated broader architecture docs:
  - `docs/tech-stack.md` now includes the orchestrator facade/internal module layout and notes that default sync routing is serialized through it
  - `docs/adr/011-temporal-workflow-engine.md` now reflects the current layered model (`sync` CLI → SyncOrchestratorWorkflow → child SyncWorkflow)
- No code/tests were run for this chunk; doc-only changes
- Chunk boundary report: ADR + surrounding architecture/user docs are aligned with the implemented orchestrator; next chunk is final verification

### Session 8 - 2026-03-06

- Completed Chunk 6a via follow-up task:
  - `.project/tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md`
- Follow-up work landed:
  - `--next` now provides explicit urgent enqueue for `sync` and `workflow start sync`
  - `--watch` now means repeat-by-request-shape when a folder or `--no-folders` scope is present
  - global `sync --watch` now clearly means repeating visible-folder discovery
  - `workflow start sync-orchestrator` is now treated as debug/internal rather than a normal user-facing start step
- Follow-up also completed the worker shutdown cleanup discovered during manual verification:
  - `src/temporal/worker.ts` no longer closes the worker connection before `worker.run()` unwinds
  - Ctrl+C shutdown no longer reproduces the earlier `IllegalStateError`

### Session 9 - 2026-03-06

- Completed Chunk 7
- Verification:
  - `pnpm test tests/orchestrator-queue.test.ts`
  - `pnpm test tests/temporal-orchestrator-workflow.test.ts`
  - `pnpm test tests/sync-command-routing.test.ts`
  - `pnpm typecheck`
- Manual Temporal verification summary:
  - started the singleton orchestrator and paused it immediately so no child syncs could run
  - enqueued a normal folder sync and an urgent folder sync
  - direct live progress query showed urgent queued ahead of normal
  - repeated the same paused-orchestrator pattern for:
    - `pnpm dev sync Home --watch --watch-interval 1`
    - `pnpm dev sync --no-folders --no-delete --limit 1 --watch --watch-interval 1`
  - live progress queries confirmed the expected watch subscriptions and queued request shapes for both folder and no-folder watch modes
  - cancelled the singleton after each scenario so no lingering watch subscriptions or child syncs remained
- API oddities guardrail:
  - no proactive no-folder fetch shaping was added in this task
  - the orchestrator work remained focused on serialization, watch scheduling, and queue behavior
- Final boundary report:
  - Sync Orchestrator Workflow implementation, follow-up watch/priority UX, verification, and worker shutdown cleanup are all complete

### Session 7a - 2026-03-06

- Captured follow-up design direction in `.project/tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md`
- Added Chunk 6a as a deferred follow-up marker so the current orchestrator task points to the next command-model cleanup
- Follow-up intent:
  - all sync entrypoints self-start through the orchestrator
  - `--watch` becomes repeat-by-request-shape
  - `--next` becomes the explicit urgent-priority flag

## Feedback

## Action Items

- Review Chunk 6 before starting Chunk 7
- Separate follow-up is now tracked in `.project/tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md`

## Notes

- Plan has extensive review feedback from 2026-02-21 with 3 high-priority, 3 medium-priority, and 3 low-priority items. All have been threaded into the relevant chunks.
- Key review items to watch: signalWithStart race (#1 high), ParentClosePolicy (#2 high), dedup key merge policy (#3 high), continue-as-new carry-forward (#4 medium)
- Related plans: Delete Coordinator (`.project/plans/2026-03-05-delete-coordinator-workflow.md`) and No-Folder Page-by-Page (implemented) are complementary but separate concerns
- 11 new files + 11 modified files + 2 documentation files per the plan's file summary
- Key patterns to reuse: two-file re-export hub, signal/handler registration, child workflow orchestration, deterministic time helpers
- The plan's "API Oddities To Explore" section is future-oriented. Do not let this task drift into proactive no-folder fetch shaping or page-size splitting unless a separate follow-up explicitly approves that scope.
