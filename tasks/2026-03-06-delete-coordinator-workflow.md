# Task: Delete Coordinator Workflow

**Status:** Complete
**Created:** 2026-03-06
**Plan:** .project/plans/2026-03-05-delete-coordinator-workflow.md

## Workflow Rules (do not remove)

- Use `/commit` after completing each chunk (not raw git commit)
- Mark completed tasks with `[x]` in this file after each chunk
- Generate chunk boundary report after each chunk
- Stop and wait for review after each chunk
- Do not batch work across chunks

## Chunks

### Chunk 1: DeleteCoordinator types and interface

- [x] Create `src/lib/delete-coordinator/types.ts` with `DeleteMode` (`blocking` | `background`), `DeleteScope`, `DrainResult`, and `DeleteCoordinator` interface (plan: Proposed Model)
- [x] Ensure the interface can represent both backlog-before-fetch deletes and current-batch-after-store deletes without losing result accounting (`backlogDeleted`, `backlogVerifyFailed`, `backlogDeleteFailed`, `newDeleted`, `newDeleteFailed`) (plan: Stage 2 - no behavior change)
- [x] Define `drainDeletes(options: { scope, mode, source })` or an equivalent split surface that preserves current lifecycle positions, plus any submit/wait split if Temporal needs it (plan: Proposed Model, Stage 2)
- [x] Export from `src/lib/delete-coordinator/index.ts` barrel (plan: Stage 2)

### Chunk 2: Inline DeleteCoordinator implementation

- [x] Create `src/lib/delete-coordinator/coordinator.ts` implementing the interface (plan: Stage 2)
- [x] Extract shared delete-with-retry, backlog read, verification, and enqueue logic from `engine/phases/process.ts` and `engine/phases/backlog.ts` into the coordinator (plan: Stage 2)
- [x] `blocking` mode: runs deletes inline and returns when scope is drained (current behavior) (plan: Expected Behavior > Folder sync)
- [x] `background` mode exists at the interface level, but Stage 2 keeps it coordinator-internal / future-facing rather than changing normal runtime behavior yet (plan: Stage 2 guardrail)
- [x] Preserve `--no-delete` as the explicit “enqueue without execute” flag; do not redefine it as general background coordinator behavior (plan: Non-Goals - no semantic changes)
- [x] Coordinator owns orchestration of rate-limit handling, retry/backoff, logging, and progress reporting through the existing ops / activity surfaces rather than bypassing them (plan: Proposed Model)

### Chunk 3: Integrate coordinator into SyncEngine and Temporal

- [x] Replace direct `runProcessPhase` / `runBacklogPhase` implementations in `SyncEngine` with coordinator calls while preserving lifecycle order: backlog delete before fetch, current-batch delete after store (plan: Stage 2)
- [x] Preserve the existing `runThroughStore()` / `runProcess()` split and `onBeforeProcess` callback position between store and delete (plan: Stage 2 - no behavior change)
- [x] Folder sync continues to use `mode: 'blocking'` in normal runtime paths (plan: Expected Behavior > Folder sync)
- [x] No-folder sync keeps current inline / sequential delete behavior for Stage 2 so the validated live semantics remain intact; do not flip normal runtime paths to true background draining yet (plan: Stage 2 guardrail)
- [x] Adapt local and Temporal runners only as needed to consume the new engine / coordinator interface; do not introduce separate page-runner policy changes beyond the refactor itself (plan: Recommended Scope)
- [x] Verify `--no-delete` still enqueues without executing, `--dry-run` skips delete entirely, and the live delete-reveal restart path for suspicious `limit=100` terminal pages still works (plan: Non-Goals / API oddities)

### Chunk 4: Tests

- [x] Unit tests for `DeleteCoordinator` — blocking mode drains all eligible, background-mode interface behavior is covered without activating new runtime semantics yet (plan: Stage 2)
- [x] Unit tests for coordinator rate-limit handling and retry behavior (plan: Proposed Model)
- [x] Integration tests confirming folder sync uses blocking mode end-to-end (plan: Expected Behavior > Folder sync)
- [x] Integration tests confirming no-folder sync keeps current sequential delete behavior under the coordinator refactor, including delete-reveal restart after a suspicious terminal page (plan: Stage 2 guardrail / API oddities)
- [x] Regression tests: existing sync behavior remains intact and focused sync test suites pass after the refactor (plan: Recommended Scope — runtime behavior unchanged)

## Progress Log

### Session 1 - 2026-03-06

- Created task from plan
- Plan: .project/plans/2026-03-05-delete-coordinator-workflow.md
- Stage 1 (page-by-page no-folder fetch/store) already implemented — this task covers Stage 2 only
- Stage 3 (dedicated delete workflow/lane) is future work
- Review update: tightened Stage 2 guardrails so this task stays a coordinator-interface refactor, not a runtime switch to true background no-folder deletes
- Review update: preserve current delete lifecycle (`backlog` before fetch, `process` after store), current `--no-delete` semantics, and the live-validated no-folder delete-reveal fallback for suspicious `limit=100` terminal pages

### Session 2 - 2026-03-06

- Completed Chunk 1
- Added `src/lib/delete-coordinator/types.ts` with:
  - `DeleteMode`
  - `DeleteSource`
  - `DeleteBookmarkRef`
  - `DeleteScope`
  - `DrainDeletesOptions`
  - `DrainResult`
  - `DeleteCoordinator`
- Added `src/lib/delete-coordinator/index.ts` barrel export
- Interface note: `source: 'backlog' | 'current-batch'` preserves lifecycle position, and `DrainResult` keeps separate backlog/new delete counters so Stage 2 can refactor behavior without collapsing accounting
- No runtime behavior changes yet
- Chunk boundary report: type/interface surface is in place; next chunk is the inline coordinator implementation that will absorb the shared backlog/process delete logic

### Session 3 - 2026-03-06

- Completed Chunk 2
- Added `src/lib/delete-coordinator/coordinator.ts`
- Implemented `InlineDeleteCoordinator` and `createInlineDeleteCoordinator(...)`
- Coordinator behavior in Stage 2:
  - resolves backlog bookmarks through `getDeleteBacklog(folderId)` when `source === 'backlog'`
  - accepts explicit current-batch bookmarks through `scope.bookmarks`
  - keeps `mode: 'blocking' | 'background'` at the interface level, but both still run inline for now
  - preserves `--no-delete` semantics via `executeDeletes: false`, which enqueues current-batch bookmarks instead of deleting them
  - preserves current callback/progress behavior for backlog vs current-batch delete loops
  - preserves delete retry / rate-limit pause-resume behavior inline through `withRateLimitRetry(...)`
- Updated barrel exports in `src/lib/delete-coordinator/index.ts`
- Verification: `pnpm typecheck`
- No engine/runtime integration yet; `SyncEngine` still uses the existing phase implementations until Chunk 3
- Chunk boundary report: coordinator implementation exists and typechecks; next chunk is wiring `SyncEngine` and the local/Temporal paths over to it without changing lifecycle order or the validated no-folder delete-reveal behavior

### Session 4 - 2026-03-06

- Completed Chunk 3
- Integrated `SyncEngine` directly with `InlineDeleteCoordinator`
- Preserved lifecycle order and semantics:
  - backlog delete still runs before fetch when `!noDelete`
  - store still finishes before delete
  - `onBeforeProcess` still runs between store and current-batch delete
  - `runThroughStore()` / `runProcess()` split remains intact
- Runtime behavior notes:
  - all normal runtime paths still use `mode: 'blocking'`
  - no-folder sync remains inline/sequential in Stage 2
  - `--no-delete` still enqueues current-batch bookmarks instead of executing deletes
  - `--dry-run` still returns before backlog/store/delete
- Local and Temporal runners required no policy changes because the refactor stayed inside `SyncEngine`
- Compatibility note: `runProcess()` after `runThroughStore()` still preserves the zero-tweet current-batch callback behavior (`onDeleteBatchStart(0)`, `Processed: 0 deleted`)
- Verification:
  - `pnpm test tests/sync-engine-decouple.test.ts tests/sync-engine-retry.test.ts tests/sync-engine-dry-run.test.ts tests/sync-runner-cursor-loop.test.ts tests/temporal-sync-workflow.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: engine/runtime integration is complete and the focused regression slice passed; next chunk is dedicated test work for the coordinator itself plus any additional regression coverage the refactor deserves

### Session 5 - 2026-03-06

- Completed Chunk 4
- Added `tests/delete-coordinator.test.ts`
- New coordinator unit coverage:
  - blocking backlog drain with verification failures, delete failures, and split `backlog*` accounting
  - interface-level `background` mode coverage without changing Stage 2 runtime semantics
  - delete rate-limit retry with pause/resume callback assertions
- Added workflow-level regression coverage in `tests/temporal-sync-workflow.test.ts` for the validated no-folder suspicious terminal-page path:
  - first fetch returns `94` with `nextToken=none`
  - workflow restarts from the top with remaining budget
  - subsequent fetches use `6` then `1`
  - final result reaches `100` fetched / deleted
- Re-ran regression suites covering folder sync, no-folder sync, cursor fallback, stop reasons, and engine integration
- Verification:
  - `pnpm test tests/delete-coordinator.test.ts tests/sync-engine-decouple.test.ts tests/sync-engine-retry.test.ts tests/sync-engine-dry-run.test.ts tests/sync-runner-cursor-loop.test.ts tests/temporal-sync-workflow.test.ts tests/sync-engine-pages.test.ts tests/sync-runner-stop-reason.test.ts`
  - `pnpm typecheck`
- Chunk boundary report: Stage 2 delete coordinator refactor is complete; coordinator types, inline implementation, engine integration, and regression coverage are all in place without changing normal runtime semantics

## Feedback

## Action Items

- `/commit` this task bundle

## Notes

- Stage 1 was implemented separately as `.project/plans/2026-03-05-no-folder-page-by-page-fetch-store.md` (status: Implemented)
- This task intentionally covers only Stage 2 (extract shared interface). Stage 3 (promote to dedicated workflow) will be a separate task once the interface stabilizes.
- Stage 3 follow-up is now tracked in `.project/tasks/2026-03-06-delete-coordinator-blocking-background-follow-up.md`.
- Current delete touchpoints: `engine/phases/process.ts` (inline deletes), `engine/phases/backlog.ts` (backlog draining), `temporal/activities/delete.ts` (Temporal activity)
- The plan's "Design Questions To Settle Later" section remains open — this implementation keeps both modes running inline while the interface solidifies.
- `background` mode in this task is an interface/design concern, not permission to change normal no-folder execution semantics yet.
