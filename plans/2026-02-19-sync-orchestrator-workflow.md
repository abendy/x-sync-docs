# Plan: Sync Orchestrator Workflow

**Status:** In Progress
**Created:** 2026-02-19
**Source:** ~/.claude/plans/splendid-snacking-nebula.md

## Plan

### Context

Running two sync workflows concurrently on separate folders is unsafe: the X API delete endpoint is global (removing a bookmark deletes it from ALL folders), so one workflow's deletes corrupt another's pagination window. Rate limiters are also per-activity-instance with no coordination, doubling 429 rates. There is currently no concurrency protection.

This plan introduces a **SyncOrchestratorWorkflow** — a singleton Temporal workflow that serializes sync operations and supports a watch mode for automatic folder cycling.

### Design

- Fixed workflow ID (`sync-orchestrator`) ensures only one instance runs at a time
- Maintains a priority queue: **urgent** (`--next`) > **fresh** (from folder API) > **normal** (default ad-hoc CLI) > **stale** (DB-only)
- Runs child `SyncWorkflow` instances sequentially (one at a time)
- Watch mode: periodically fetches folder endpoint, merges with all known DB folders, queues syncs
- Ad-hoc `sync folder-123` defaults to normal priority; `--next` promotes it to urgent priority
- Uses `wf.continueAsNew()` after 50 child completions to bound event history
- Deduplication: if a folder is already queued, higher-priority requests promote it; lower-priority ones are ignored

### Related Future Work

This plan stays focused on **sync request serialization**. Two closely related follow-ups should stay separate:

- **No-folder page-by-page fetch/store** should likely land before any larger delete coordination refactor. Unlike folder sync, `--no-folders` does not rely on delete completion to reveal the next fetch page, so it can move toward bounded-memory `fetch -> store` cycles without changing orchestrator responsibilities.
- **Delete coordination** should be designed in its own plan. The likely long-term shape is a shared delete coordinator with `blocking` mode for folder sync and `background` mode for no-folder sync, but that is intentionally outside the scope of this document.

The orchestrator may eventually hand work to a delete coordinator, but it should not absorb delete-lane design, priority arbitration, or blocking/background semantics into this plan.

### API Oddities To Explore

Live no-folder testing found that the all-bookmarks endpoint can behave differently at nearby request sizes:

- `limit=95` can page normally
- `limit=100` can return a false terminal page (`94`, `nextToken=none`)
- the current live workaround succeeds by deleting the visible window, then restarting from the top with the remaining budget

If we later want to optimize around this proactively, the orchestrator is a plausible place to experiment with fetch-shaping policy for no-folder runs:

- "Fetch shaping" here means proactively adjusting request size/segmentation before fallback is needed.
- cap per-request no-folder fetch size below a proven-safe threshold instead of always asking for `100`
- slice large requested limits into orchestrated sub-runs or bounded fetch segments without changing the user-facing overall limit
- keep the reactive delete-reveal fallback as a safety net even if a proactive safe page size is introduced

This should stay exploratory until the endpoint behavior looks stable enough to justify policy instead of pure fallback handling.

Fairness controls are also intentionally out of scope for now:

- do not redesign queue fairness between repeating urgent watches, discovery refreshes, and future background delete work in the same pass
- keep the current urgent-vs-normal model until there is a real operational need for something more advanced

One practical follow-up is also worth tracking outside the core orchestrator behavior:

- `workflow status sync-orchestrator` did not surface the full queue/watch snapshot during manual verification because the progress-query rendering path failed quietly and only the high-level header printed
- direct Temporal query output still gave the needed live state, so this is a CLI visibility/debuggability follow-up, not an orchestrator correctness issue
- even after the query-render bug was improved, completed orchestrator runs still report only a thin final result; richer completed-run summaries and clearer handoff messaging remain worth exploring

### Implementation Steps

#### Step 1: Shared types

**Create** `src/temporal/shared/orchestrator-types.ts`

Types needed:

- `SyncPriority` — `'urgent' | 'fresh' | 'stale'`
- `SyncRequest` — `{ folderId: string | null, priority, pages?, noDelete?, noFolders?, requestedAt }`
- `SyncOrchestratorWorkflowInput` — `{ watch?, watchIntervalMs?, initialQueue?, completedChildCount?, totalSynced?, lastFolderRefreshAt? }`
- `SyncOrchestratorWorkflowResult` — `{ totalChildrenCompleted, totalSynced, status, durationMs }`
- `SyncOrchestratorProgress` — queryable state for CLI status display
- `EnqueueSyncSignalPayload` — signal payload for ad-hoc requests
- `GetKnownFoldersOutput` — activity return type

**Modify** `src/temporal/shared/types.ts` — add `export * from './orchestrator-types.js'`

#### Step 2: Priority queue data structure

**Create** `src/temporal/workflows/orchestrator/queue.ts`

Pure data structure, no Temporal imports. Sorted-array implementation (queue size ~tens of items).

- `createPriorityQueue(initial?): PriorityQueue`
- Methods: `enqueue` (with dedup/promote), `dequeue`, `peek`, `contains`, `promote`, `remove`, `toArray`, `size`
- Priority ordering: urgent (0) > fresh (1) > stale (2)
- `enqueue` deduplicates by `folderId` — promotes if higher priority, ignores if same or lower

**Create** `tests/orchestrator-queue.test.ts` — pure unit tests for queue behavior

#### Step 3: New activities

**Modify** `src/temporal/activities/query.ts` — add two functions:

- `getKnownFolders()` — calls `db.getFolders()` (existing `FolderRepo.getFolders()`), maps to `GetKnownFoldersOutput`
- `cacheFolders({ folders })` — calls `db.upsertFolder()` (existing `FolderRepo.upsertFolder()`) for each folder

No change to `src/temporal/activities/index.ts` needed (already re-exports all of `query.ts`).

#### Step 4: Workflow internals

**Create** `src/temporal/workflows/orchestrator/signals.ts`

Signals:

- `enqueueSyncSignal` — `wf.defineSignal<[EnqueueSyncSignalPayload]>('enqueueSync')`
- `startWatchSignal`, `stopWatchSignal` — `wf.defineSignal('startWatch'/'stopWatch')`
- `pauseSignal`, `resumeSignal`, `cancelSignal` — standard control signals
- `progressQuery` — `wf.defineQuery<SyncOrchestratorProgress>('progress')`

**Create** `src/temporal/workflows/orchestrator/activities.ts`

- `orchestratorActivities = wf.proxyActivities(...)` with 2-minute `startToCloseTimeout`
- Destructure: `fetchFolders`, `getKnownFolders`, `cacheFolders`

**Create** `src/temporal/workflows/orchestrator/state.ts`

- `OrchestratorRuntimeState` — isPaused, isCancelled, watchEnabled, currentChild*, completedChildren, totalSynced, lastFolderRefreshAt, lastError
- `createOrchestratorRuntimeState(params?)` factory

**Create** `src/temporal/workflows/orchestrator/handlers.ts`

- `registerOrchestratorHandlers({ state, queue })` — wires all signal/query handlers
- `enqueueSyncSignal` handler calls `queue.enqueue()` with the payload
- `progressQuery` handler returns current state + queue snapshot

#### Step 5: Main workflow + exports

**Create** `src/temporal/workflows/orchestrator/index.ts`

Main loop:

```text
1. If watch mode and queue empty → refreshFolderQueue()
2. While not cancelled:
   a. Pause check (wf.condition)
   b. Continue-as-new check (after 50 children)
   c. Drain queue: dequeue → startChild(syncWorkflow) → await result → update state
   d. If not watch mode and queue empty → break (done)
   e. If watch mode: wf.condition(queue.size > 0 || cancelled || !watchEnabled, watchIntervalMs)
      - Timeout expired → refreshFolderQueue()
      - Signal arrived → loop back to drain
```

`refreshFolderQueue()`:

- Call `fetchFolders()` activity → enqueue each as `fresh`
- Call `cacheFolders()` to persist API folders to DB
- Call `getKnownFolders()` activity → enqueue DB-only folders as `stale`

Child sync execution:

- `wf.startChild(syncWorkflow, { workflowId: childId, args: [input], parentClosePolicy: ABANDON })`
- Await `handle.result()` for sequential execution
- Catch errors → record in `state.lastError`, continue to next

Constants:

- `ORCHESTRATOR_WORKFLOW_ID = 'sync-orchestrator'`
- `CONTINUE_AS_NEW_THRESHOLD = 50`
- `DEFAULT_WATCH_INTERVAL_MS = 30 * 60 * 1000` (30 min)

**Create** `src/temporal/workflows/orchestrator.ts` — thin re-export hub

**Modify** `src/temporal/workflows/index.ts` — add orchestrator exports block with prefixed aliases (`orchestratorPauseSignal`, etc.)

#### Step 6: CLI — WorkflowKind and start command

**Modify** `src/commands/workflow/shared.ts`

- Add `'sync-orchestrator'` to `WorkflowKind` union
- Add `syncOrchestratorWorkflow` to `WORKFLOW_LIST_QUERY`

**Modify** `src/commands/workflow/start-command/types.ts`

- Add `watch?: boolean` to `StartOptions`

**Modify** `src/commands/workflow/start-command/register.ts`

- Add `.option('--watch', 'Enable watch mode (sync-orchestrator only)')` to start command

**Create** `src/commands/workflow/start-command/sync-orchestrator.ts`

- `startSyncOrchestratorWorkflow(context)` — starts with fixed ID, passes `{ watch }` input

**Modify** `src/commands/workflow/start-command/handlers.ts`

- Add `'sync-orchestrator': startSyncOrchestratorWorkflow` to `START_HANDLERS`
- Update error message in `startWorkflowByType` to include `'sync-orchestrator'`

#### Step 7: CLI — sync bookmarks routes through orchestrator

**Modify** `src/commands/sync/bookmarks/temporal.ts`

Replace standalone `SyncWorkflow` start with orchestrator routing:

1. Check if orchestrator is running (`client.workflow.getHandle(ORCHESTRATOR_WORKFLOW_ID).describe()`)
2. If running: signal with `orchestratorEnqueueSyncSignal` (priority `urgent`)
3. If not running: start orchestrator with the request in `initialQueue`

**Modify** `src/commands/sync/bookmarks/register.ts`

- Add `--watch` option: `'Enable watch mode — automatically cycle through all folders'`
- Add `--watch-interval <minutes>` option for configurable interval

**Modify** `src/commands/sync/bookmarks/types.ts`

- Add `watch?: boolean` and `watchInterval?: string` to `SyncBookmarksOptions`

**Modify** `src/commands/sync/bookmarks/options.ts`

- Handle `--watch` in resolution (sets watch mode, implies Temporal)

#### Step 8: CLI — control and status

**Modify** `src/commands/workflow/control.ts`

- Add `syncOrchestratorWorkflow` case to pause/resume/cancel handlers using orchestrator signals

**Modify** `src/commands/workflow/status-command/progress.ts`

- Add `syncOrchestratorWorkflow` case to `renderRunningProgress()`
- New `renderOrchestratorProgress()` showing: mode, watch status, queue contents (with priority colors), current child, completed count, next refresh time

#### Step 9: Workflow tests

**Create** `tests/temporal-orchestrator-workflow.test.ts`

Follow exact pattern from `tests/temporal-sync-workflow.test.ts`:

- `vi.hoisted()` for mock activities and mock Temporal module
- `vi.mock('@temporalio/workflow', ...)`
- Test cases: single request processing, priority ordering, watch mode timer, enqueue signal during idle, pause/resume, cancel, continue-as-new trigger, child failure handling

#### Step 10: ADR documentation

**Create** `docs/adr/032-sync-orchestrator-workflow.md`

- Problem: concurrent folder syncs corrupt pagination via global delete
- Decision: singleton orchestrator with priority queue and watch mode
- Consequences: all syncs serialized, watch mode for automated cycling

### Files Summary

#### New files (11)

| File | Purpose |
| --- | --- |
| `src/temporal/shared/orchestrator-types.ts` | Shared types |
| `src/temporal/workflows/orchestrator/queue.ts` | Priority queue |
| `src/temporal/workflows/orchestrator/signals.ts` | Signal/query definitions |
| `src/temporal/workflows/orchestrator/activities.ts` | Activity proxy |
| `src/temporal/workflows/orchestrator/state.ts` | Runtime state factory |
| `src/temporal/workflows/orchestrator/handlers.ts` | Handler registration |
| `src/temporal/workflows/orchestrator/index.ts` | Main workflow |
| `src/temporal/workflows/orchestrator.ts` | Re-export hub |
| `src/commands/workflow/start-command/sync-orchestrator.ts` | Start command handler |
| `tests/orchestrator-queue.test.ts` | Queue unit tests |
| `tests/temporal-orchestrator-workflow.test.ts` | Workflow unit tests |

#### Modified files (11)

| File | Change |
| --- | --- |
| `src/temporal/shared/types.ts` | Add orchestrator re-export |
| `src/temporal/activities/query.ts` | Add `getKnownFolders`, `cacheFolders` |
| `src/temporal/workflows/index.ts` | Add orchestrator exports |
| `src/commands/workflow/shared.ts` | Add `'sync-orchestrator'` to WorkflowKind, update list query |
| `src/commands/workflow/start-command/types.ts` | Add `watch` to StartOptions |
| `src/commands/workflow/start-command/register.ts` | Add `--watch` option |
| `src/commands/workflow/start-command/handlers.ts` | Add orchestrator handler |
| `src/commands/sync/bookmarks/temporal.ts` | Route through orchestrator |
| `src/commands/sync/bookmarks/register.ts` | Add `--watch` option |
| `src/commands/workflow/control.ts` | Add orchestrator pause/resume/cancel |
| `src/commands/workflow/status-command/progress.ts` | Add orchestrator progress rendering |

#### Documentation (2)

| File | Change |
| --- | --- |
| `docs/adr/032-sync-orchestrator-workflow.md` | New ADR |

### Key Patterns Reused

- **Two-file re-export**: `orchestrator.ts` hub → `orchestrator/index.ts` impl (same as sync, enrich)
- **Signal/handler registration**: `registerOrchestratorHandlers()` (same as `registerSyncHandlers()` in `sync/handlers.ts`)
- **Child workflow orchestration**: `wf.startChild()` + `handle.result()` (similar to `enrich-orchestrator.ts` but awaits result for serialization)
- **Activity proxy**: `wf.proxyActivities<typeof import(...)>()` (same as `sync/activities.ts`)
- **Deterministic time**: `workflowNowMs()`, `workflowNowIso()`, `workflowAfterMsIso()` from `workflows/time.ts`
- **Workflow ID**: fixed `ORCHESTRATOR_WORKFLOW_ID` (singleton pattern, vs `generateWorkflowId()` for unique ones)
- **CLI routing**: `withTemporalClientOrExit()` wrapper (from `commands/shared/temporal.ts`)
- **FolderRepo**: `getFolders()` and `upsertFolder()` from `src/lib/db/folder-repo.ts`
- **fetchFolders activity**: existing in `src/temporal/activities/fetch.ts`

### Verification

1. **Queue tests**: `vitest run tests/orchestrator-queue.test.ts`
2. **Workflow tests**: `vitest run tests/temporal-orchestrator-workflow.test.ts`
3. **Full suite**: `pnpm test`
4. **Lint + typecheck**: `pnpm lint && pnpm typecheck`
5. **Manual E2E** (requires Temporal dev server):
   - `pnpm temporal:dev` + `pnpm dev:worker`
   - `pnpm dev sync folder-123` — starts orchestrator, runs sync
   - `pnpm dev workflow status sync-orchestrator` — shows progress
   - `pnpm dev sync folder-456` — signals running orchestrator (urgent)
   - `pnpm dev sync --watch` — starts watch mode
   - `pnpm dev workflow pause sync-orchestrator` / `resume` / `cancel`

## Feedback

### Review Notes (2026-02-21)

#### Must-fix before implementation

1. **High — Start/signal race can create duplicate-start failures and dropped urgent requests.**
   - Step 7 uses `describe()` then either `signal` or `start`; this is non-atomic.
   - Use `signalWithStart` on `ORCHESTRATOR_WORKFLOW_ID` (or catch `WorkflowExecutionAlreadyStartedError` then signal).
   - Add a test where two concurrent `sync` invocations both enqueue without failure.

2. **High — `ParentClosePolicy.ABANDON` conflicts with the serialization safety goal.**
   - In Step 5, cancelling/restarting the orchestrator can leave a child `SyncWorkflow` running.
   - This can reintroduce concurrent delete windows if a new orchestrator run starts.
   - Prefer `REQUEST_CANCEL` (or explicit child cancel + await) on orchestrator shutdown.

3. **High — Queue dedup key is underspecified and can merge semantically different requests.**
   - Step 2 dedups only by `folderId`, but request shape also includes `noDelete`, `noFolders`, and `pages`.
   - Define a canonical dedup key and merge policy so we do not silently drop distinct execution intents.
   - Example that must be defined: queued `folder-123` with `noDelete=false`, then urgent enqueue for same folder with `noDelete=true`.

4. **Medium — Continue-as-new carry-forward contract is incomplete.**
   - Step 5 mentions a threshold check but not full carry-forward state requirements.
   - Specify continuation payload fields (queue snapshot, counters, watch state, `lastFolderRefreshAt`, control flags).
   - Add a no-loss/no-dup continuation test with a non-empty queue.

5. **Medium — Folder refresh logic currently ignores folder pagination.**
   - `fetchFolders()` returns `{ folders, nextToken }`; plan currently enqueues one response page only.
   - Either explicitly document a single-page assumption or add paginated folder refresh behavior.

6. **Medium — CLI plumbing is incomplete for `--watch-interval`.**
   - Step 7 updates raw options, but resolved option typing/parsing/validation and propagation are not fully specified.
   - Add strict positive-integer parsing, bounds/default behavior, and pass-through into orchestrator input.

#### Architecture and documentation improvements

1. **Low — Keep activity layering consistent.**
   - `cacheFolders` is a write operation but Step 3 places it in `query.ts` (read-oriented file).
   - Consider placing it in `store.ts` to preserve existing architecture boundaries.

2. **Low — Avoid singleton ID string drift.**
   - Export `ORCHESTRATOR_WORKFLOW_ID` from a shared module consumed by both workflow and CLI routes.

3. **Low — Clarify control semantics in ADR.**
   - Document whether pause/resume/cancel affect only orchestrator scheduling or also the currently running child sync.

#### Additional tests recommended

- Concurrent `sync` CLI calls to verify atomic enqueue/start behavior.
- Cancel orchestrator while child is active, then restart, to verify no overlap.
- Dedup/merge behavior for same folder with different request flags.
- Continue-as-new with pending queue plus watch mode enabled.
- Folder refresh behavior when folder API pagination is present.
