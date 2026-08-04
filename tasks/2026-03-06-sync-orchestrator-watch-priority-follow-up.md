# Task: Sync Orchestrator Watch + Priority Follow-up

**Status:** Complete
**Created:** 2026-03-06
**Related Plan:** .project/plans/2026-02-19-sync-orchestrator-workflow.md
**Related ADR:** docs/adr/032-sync-orchestrator-workflow.md
**Source:** Follow-up design discussion after orchestrator implementation

## Goal

Tighten the sync command model so it is easier to explain and easier to use:

- all sync entrypoints should go through the orchestrator and self-start it when needed
- `--watch` should mean "repeat this sync shape at an interval"
- `--next` should mean "enqueue this sync shape at urgent priority"

## Target Command Model

- `sync`
  - enqueue once at normal priority
- `sync --watch`
  - repeat at interval, enqueueing global folder-discovery work at normal priority
- `sync Home --watch`
  - repeat that folder sync at interval, enqueueing at normal priority
- `sync --no-folders --watch`
  - repeat that no-folder sync at interval, enqueueing at normal priority
- `sync --next`
  - enqueue once at urgent priority
- `sync --next --watch`
  - repeat at interval, enqueueing urgent work each time

`workflow start sync ...` should remain the explicit workflow-command form of the same orchestrated request path.

`workflow start sync-orchestrator` should no longer be needed as a user-facing start command if all sync entrypoints self-start the singleton cleanly.

## Decisions Captured Here

- Use the simple priority model: repeated `--next --watch` runs stay urgent on every enqueue.
- Prefer warnings over hard errors for intentionally low watch intervals.
- Keep the fixed workflow ID (`sync-orchestrator`) for status/control even if the explicit start command is retired from normal docs/usage.

## Non-Goals

- Do not fold in Delete Coordinator Stage 3 work here.
- Do not redesign fairness/preemption beyond the simple urgent-vs-normal queue already in place.
- Do not try to solve folder endpoint pagination limits here.
- Do not pull proactive no-folder fetch shaping into this task.

## Open Questions To Resolve During Implementation

- Whether `workflow start sync-orchestrator` should be removed entirely or kept as an internal/debug-only path.
- What interval threshold should produce a warning for `--watch`, especially with `--next --watch`.
- Whether low-interval warnings should be stronger when the request shape is no-folder.

## Chunks

### Chunk 1: CLI model and request shape

- [x] Add `--next` to sync CLI surfaces that enqueue orchestrated sync work
- [x] Extend orchestrator request/subscription types so one-off requests and repeating watched requests are both represented cleanly
- [x] Make `workflow start sync` and `sync` continue to share the same orchestrated request path
- [x] Decide whether `workflow start sync-orchestrator` is retired, hidden, or kept as debug-only

### Chunk 2: Orchestrator watch semantics

- [x] Implement repeating watch behavior by request shape:
  - global folder discovery when no folder/no-folder scope is provided
  - exact folder repeat when a folder scope is provided
  - exact no-folder repeat when `--no-folders` is provided
- [x] Ensure watched requests re-enqueue through the same queue/priority system as one-off requests
- [x] Preserve self-start behavior so no separate orchestrator start step is required

### Chunk 3: UX and docs

- [x] Add low-interval warnings for `--watch` without blocking execution
- [x] Update CLI help text and user-facing output to explain `--watch` and `--next` plainly
- [x] Update README / ADR 011 / ADR 032 / CLAUDE docs to match the new command model
- [x] Remove or reframe any docs that still imply a separate user-facing orchestrator start path is required

### Chunk 4: Tests and verification

- [x] Add/adjust routing tests for `sync`, `sync --watch`, `sync --next`, `sync --next --watch`
- [x] Add orchestrator workflow tests for repeating scoped watch requests and urgent watched requests
- [x] Run focused CLI/orchestrator tests plus typecheck
- [x] Run a small manual Temporal verification pass for:
  - one-off normal request
  - one-off urgent request
  - repeating folder watch
  - repeating no-folder watch

## Notes

- This is a follow-up to the first orchestrator landing, not a rewrite.
- Keep the behavior easy to explain from the CLI first; do not over-engineer fairness policy in the same pass.
- Current Chunk 1 decision: keep `workflow start sync-orchestrator` temporarily as a debug/internal command while normal sync entrypoints self-start through the orchestrator.

## Progress Log

### Session 1 - 2026-03-06

- Completed Chunk 1
- Added `--next` to orchestrated sync CLI surfaces:
  - `src/commands/sync/bookmarks/register.ts`
  - `src/commands/workflow/start-command/register.ts`
- Added first-pass request/subscription modeling:
  - `src/temporal/shared/orchestrator-types.ts` now defines `SyncRequestShape`, `SyncWatchSubscription`, `SyncRequestedPriority`, and `watchSubscriptions` carry-forward/progress fields
  - queue keys now derive from the shared request-shape helper
- Changed default CLI enqueue priority from urgent to normal:
  - regular `sync` / `workflow start sync` now enqueue as `normal`
  - `--next` maps to urgent priority
  - internal watch refresh still keeps `fresh` / `stale`
- Kept `workflow start sync` on the same orchestrated path as `sync`
- Marked `workflow start sync-orchestrator` as debug/internal for now instead of removing it in this chunk
- Stored watch-subscription metadata in orchestrator state/query/continue-as-new without changing scheduling behavior yet
- Verification:
  - `pnpm test tests/sync-command-routing.test.ts tests/orchestrator-queue.test.ts tests/temporal-orchestrator-workflow.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: request shape, queue priority, and first-pass watch-subscription plumbing are in place; next chunk is real repeating watch behavior by request shape

### Session 2 - 2026-03-06

- Completed Chunk 2
- Implemented repeating watch behavior inside the orchestrator workflow:
  - `discovery` subscriptions continue to refresh visible folders into the shared queue
  - `request` subscriptions now re-enqueue their exact request shape on interval
  - request watches preserve their configured priority on every repeat, including urgent `--next --watch`
- Added watch scheduling state to the runtime:
  - `watchConfigVersion` now breaks the watch wait loop cleanly when subscriptions change
  - per-subscription due times are tracked by subscription key and carried through watch handler updates
- Kept the startup behavior intentionally narrow:
  - global discovery watch still refreshes immediately when watch mode starts and the queue is empty
  - scoped folder / no-folder watch waits for its first interval instead of forcing an extra immediate duplicate enqueue
- Verification:
  - `pnpm test tests/temporal-orchestrator-workflow.test.ts tests/sync-command-routing.test.ts tests/orchestrator-queue.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: repeating watch semantics now work by request shape and still flow through the same orchestrator queue; next chunk is CLI warnings, help text, and docs

### Session 3 - 2026-03-06

- Completed Chunk 3
- Added shared watch UX helpers:
  - `src/commands/sync/bookmarks/watch-ux.ts`
  - plain-language watch summaries for discovery watch, folder watch, and no-folder watch
  - low-interval warning messages for 5-minute-and-under watch intervals
  - stronger follow-up warnings for `--next --watch` and `--no-folders --watch`
- Updated CLI help text and command output:
  - `sync` and `workflow start sync` now describe `--watch` as repeat-by-shape rather than generic watch mode
  - `--next` is described as queueing ahead of normal work
  - success output now distinguishes `watch enabled` from one-off enqueue
- Updated docs to match the current command model:
  - `README.md`
  - `docs/adr/011-temporal-workflow-engine.md`
  - `docs/adr/032-sync-orchestrator-workflow.md`
  - `CLAUDE.md`
- Reframed `workflow start sync-orchestrator` as debug/internal documentation rather than a normal start path
- Verification:
  - `pnpm test tests/sync-command-routing.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: CLI wording and docs now match the repeat-by-request-shape watch model; next chunk is broader test coverage plus manual Temporal verification

### Session 4 - 2026-03-06

- Completed Chunk 4 and closed the task
- Expanded automated coverage:
  - `tests/sync-command-routing.test.ts`
    - added `sync --watch --next` routing coverage to verify urgent repeating discovery watch payloads
  - `tests/temporal-orchestrator-workflow.test.ts`
    - added urgent watched-request ordering coverage to verify watched urgent requests run ahead of watched normal requests when both are due
- Verification:
  - `pnpm test tests/sync-command-routing.test.ts tests/temporal-orchestrator-workflow.test.ts tests/orchestrator-queue.test.ts`
  - `pnpm typecheck`
- Manual Temporal verification approach:
  - started the singleton orchestrator in debug/internal mode
  - paused it immediately so no child syncs could start
  - enqueued real `sync ...` requests against the paused orchestrator
  - inspected live orchestrator progress via direct Temporal query
  - cancelled the singleton after each scenario to avoid leaving watch subscriptions behind
- Manual verification results:
  - one-off normal + urgent requests:
    - `pnpm dev sync Home`
    - `pnpm dev sync AI --next`
    - live orchestrator progress showed the urgent `AI` request queued ahead of the normal `Home` request
  - repeating folder watch:
    - `pnpm dev sync Home --watch --watch-interval 1`
    - live orchestrator progress showed `watchEnabled=true`, a `request` watch subscription for folder `Home`, `priority=normal`, and a matching queued folder request
  - repeating no-folder watch:
    - `pnpm dev sync --no-folders --no-delete --limit 1 --watch --watch-interval 1`
    - live orchestrator progress showed `watchEnabled=true`, a `request` watch subscription with `noFolders=true`, `noDelete=true`, `limit=1`, `priority=normal`, and a matching queued all-bookmarks request
- Manual verification note:
  - `workflow status sync-orchestrator` only showed the high-level header during this session
  - the workflow did have live queue/watch state; a direct `orchestratorProgressQuery` from a local script returned it correctly
  - the CLI status path prints the header first, then swallows progress-query/render errors in `showWorkflowStatus(...)`, so this looked like "status works but has no detail"
  - for the live queue/watch snapshot I used a direct Temporal query from a local script instead
- Out-of-scope issue discovered during cleanup:
  - starting the Temporal worker for the live progress query succeeded
  - stopping it with Ctrl+C ended with `IllegalStateError: Cannot close connection while Workers hold a reference to it` from `src/temporal/worker.ts`
  - this did not affect the orchestrator verification, but it should be tracked as a worker shutdown follow-up
- Final boundary report: command routing, watch semantics, UX/docs, automated coverage, and safe live orchestrator verification are all complete for this follow-up task

### Session 5 - 2026-03-06

- Completed the worker shutdown follow-up noted in Session 4
- Fixed the Temporal worker teardown path in `src/temporal/worker.ts`:
  - signal shutdown now only asks the worker to stop
  - connection close is owned by the outer cleanup path after `worker.run()` unwinds
  - cleanup is now single-path instead of split between the signal handler and outer `finally`
  - startup failure after connection creation is also cleaned up more safely
- Verification:
  - `pnpm typecheck`
  - manual `pnpm dev:worker` start + Ctrl+C shutdown check
- Result:
  - the previous `IllegalStateError: Cannot close connection while Workers hold a reference to it` no longer reproduced
  - Ctrl+C now exits with status `130`, which is expected shell behavior
- Final note:
  - the worker shutdown cleanup from Session 4 is now resolved

## Action Items

- None
