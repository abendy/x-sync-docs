# Task: Sync Orchestrator + Delete Coordinator Live Test Checklist

**Status:** In Progress
**Created:** 2026-03-07
**Related Plans:**

- .project/plans/2026-02-19-sync-orchestrator-workflow.md
- .project/plans/2026-03-05-delete-coordinator-workflow.md

**Related ADRs:**

- docs/adr/031-delete-coordinator-workflow.md
- docs/adr/032-sync-orchestrator-workflow.md

**Related Tasks:**

- .project/tasks/2026-03-06-sync-orchestrator-workflow.md
- .project/tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md
- .project/tasks/2026-03-07-delete-coordinator-full-ownership.md

## Goal

Do a real Temporal behavior pass after the recent workflow changes:

- sync requests go through the singleton orchestrator
- delete work goes through the delete coordinator
- watch and `--next` behavior works the way the CLI now describes it
- queue behavior matches the current dedup and priority rules

## Current Expected Behavior

### Orchestrator

- Different sync requests are serialized; only one child sync should run at a time.
- Queued duplicate requests are deduped by request shape:
  - `folderId`
  - `noFolders`
  - `noDelete`
  - `resume`
  - `pages`
  - `limit`
- If the same queued request is enqueued again with higher priority, it should be promoted instead of duplicated.
- Watch subscriptions are deduped by subscription key.
- There is **not yet** a guardrail against enqueueing the same sync again while that exact request is already running.

### Delete Coordinator

- Backlog-before-fetch delete should run through `delete-coordinator` in `blocking`.
- Folder current-batch delete should run through `delete-coordinator` in `blocking`.
- No-folder current-batch delete should run through `delete-coordinator` too:
  - normal pages -> `background`
  - suspicious terminal reveal pages -> `blocking`
- There is **not yet** active-job preemption:
  - queued blocking work outranks queued background work
  - but a blocking folder delete does not interrupt an already running background no-folder delete

## Current Status

- Next up later with `--no-delete`: Chunk 3 `<folder> --next --watch` and Chunk 4 active-duplicate testing.
  Note: these are most meaningful once a folder has `20-40+` live bookmarks again, so the sync runs long enough for queue order and mid-flight duplicate behavior to be observable.
- After that: `pnpm dev sync --watch` discovery watch.
  Note: most useful when multiple visible folders exist and there is some chance of folder-list churn between watch intervals.
- Chunk 2: No-folder edge path.
  Note: only interesting when the live all-bookmarks endpoint still reproduces the suspicious `100 -> short page + no nextToken` behavior.
  Blocker: folder sync work should be finished first, because this depends on a real delete-enabled no-folder run that can remove bookmarks from X before their folder membership has been archived.
- Chunk 5: Overlap / operational reality.
  Note: this needs a delete-enabled no-folder run large enough to keep `delete-coordinator` busy after the sync child completes.
  Blocker: folder sync work should be finished first, because this also depends on a real delete-enabled no-folder run that can remove bookmarks from X before their folder membership has been archived.

## Live Checklist

### Chunk 1: Baseline Regular Sync

- [x] Run one regular folder sync through `pnpm dev sync <folder>`
- [x] Confirm it starts `sync-orchestrator`
- [x] Confirm it starts one child `sync-orchestrator-sync-*`
- [x] Confirm folder delete runs through `delete-coordinator`
- [x] Confirm enrich/media behavior still looks correct when applicable
- [x] Run one regular no-folder sync through `pnpm dev sync --no-folders --limit <small>`
- [x] Confirm normal no-folder delete handoff goes to `delete-coordinator`
- [x] Confirm `workflow status delete-coordinator` is useful during the run

### Chunk 2: No-Folder Edge Path

- [ ] Run `pnpm dev sync --no-folders --limit 100`
- [ ] Confirm the suspicious terminal-page path still works if reproduced
- [ ] Confirm no-folder delete escalates to `blocking` when delete-reveal is needed
- [ ] Confirm final fetched/stored/deleted counts still make sense

### Chunk 3: Priority + Watch

- [x] Run `pnpm dev sync <folder> --next`
- [x] Confirm it queues ahead of normal work
- [ ] Run `pnpm dev sync --watch`
- [ ] Confirm discovery watch refreshes visible folders and re-enqueues them
- [x] Run `pnpm dev sync <folder> --watch`
- [x] Confirm the exact folder request repeats on interval
- [x] Run `pnpm dev sync --no-folders --watch`
- [x] Confirm the exact no-folder request repeats on interval
- [ ] Run `pnpm dev sync <folder> --next --watch`
- [ ] Confirm each repeat stays urgent, as currently designed

### Chunk 4: Queue Behavior

- [x] Queue multiple different folder syncs
- [x] Confirm they run one at a time in expected priority order
- [x] Queue the same folder sync twice while it is still queued
- [x] Confirm it is deduped or promoted instead of duplicated
- [ ] Queue the same folder sync again while it is already running
- [ ] Observe current behavior and record it explicitly
- [ ] Decide whether the current behavior is acceptable or should become a follow-up task

### Chunk 5: Overlap / Operational Reality

- [ ] Start a no-folder sync that hands delete off in `background`
- [ ] While background delete is still draining, enqueue a folder sync
- [ ] Confirm what happens in practice:
  - sync serialization
  - delete-coordinator queue order
  - whether folder progress is delayed behind active background delete
- [ ] Record whether current behavior is acceptable for now

## Notes To Capture While Testing

- Whether CLI output clearly tells the user who owns current work
- Whether `workflow status sync-orchestrator` and `workflow status delete-coordinator` are enough without opening Temporal Web
- Whether worker logs feel informative without being noisy
- Any surprising queue duplication or watch-repeat behavior
- Any friction from the lack of active-job preemption

## Session Log

### Session 1

- Ran `pnpm dev sync "DEVELOPER ENVIRONMENT"`.
- CLI resolved folder name to `DEVELOPER ENVIRONMENT (1800311091467063405)` and enqueued through `sync-orchestrator`.
- Worker log confirmed:
  - `sync-orchestrator` started
  - child sync `sync-orchestrator-sync-1` started
  - `delete-coordinator` started and ran a `backlog` job
  - folder fetch returned `1` bookmark with `completeness=ids_only`
  - store wrote `1` new stub tweet
  - enrich child started and completed
  - `delete-coordinator` ran a `current-batch` job
  - bookmark delete from X succeeded
  - media download completed
- `pnpm dev workflow status sync-orchestrator` showed a good completed summary:
  - child sync details
  - enrich child details
  - media child details
- `pnpm dev workflow status delete-coordinator` showed a useful idle summary after completion:
  - `Queue: 0`
  - `Completed Jobs: 2`
  - `Total Deleted: 1`
  - `Total Failed: 0`

### Session 2

- Ran `pnpm dev sync --no-folders --limit 5`.
- CLI enqueued `all bookmarks` through `sync-orchestrator`.
- Worker log confirmed:
  - child sync fetched `5` full bookmarks with `nextToken=present`
  - store completed before delete
  - `delete-coordinator` ran a `backlog` job and then a `current-batch` job
  - sync workflow completed before the deletes finished
  - delete API calls continued under `delete-coordinator` after sync completion
- `pnpm dev workflow status sync-orchestrator` showed:
  - `fetched=5, stored=5, new=5, deleted=0`
  - this is expected for the current background-delete model because the delete work is no longer owned by the sync child after handoff
- `pnpm dev workflow status delete-coordinator` showed useful ownership/progress after the run:
  - `Queue: 0`
  - `Completed Jobs: 4`
  - `Total Deleted: 6`
  - `Total Failed: 0`

### Session 3

- Started `sync-orchestrator` explicitly and paused it to inspect live queue behavior before execution.
- Enqueued:
  - `pnpm dev sync Business`
  - `pnpm dev sync AI`
  - `pnpm dev sync AI --next`
  - `pnpm dev sync Business`
- While paused, `pnpm dev workflow status sync-orchestrator` showed:
  - `Queue: 2`
  - `AI` queued as `[urgent]`
  - `Business` queued as `[normal]`
- That confirms:
  - queued duplicate `Business` was deduped
  - queued `AI --next` promoted the queued `AI` request instead of creating a second copy
- After resume, worker log confirmed execution order:
  - `AI` ran first
  - `Business` ran second
  - no concurrent child syncs
- Final orchestrator status showed:
  - `Completed Children: 2`
  - recent children in that same order (`AI` urgent, then `Business` normal)
- Note: the overall orchestrator duration included the intentional paused period, so the elapsed time there is not a pure work-duration signal.

### Session 4

- Ran `pnpm dev sync IDE --no-delete --watch --watch-interval 1`.
- `pnpm dev workflow status sync-orchestrator` showed the watched folder request staying active with `Watch: enabled` and a `1 minute` interval.
- Worker log confirmed the exact folder request repeated on interval:
  - initial watch cycles fetched `0`, then `1`, then continued to re-fetch that same `1` bookmark without deleting it
  - after adding a new `IDE` bookmark in the iOS app, the next watch cycle fetched `2`
  - that cycle stored `1 new` bookmark and started/completed enrich
  - no delete calls occurred during the watched `--no-delete` runs
- Manual `pnpm dev sync IDE --no-delete` matched the watch behavior:
  - fetched `1`
  - stored `0 new`
  - deleted nothing
- This confirms:
  - folder watch repeats the exact folder request shape on interval
  - `--no-delete` preserves bookmarks on X during watched folder runs
  - newly added folder bookmarks are picked up on the next watch cycle

### Session 5

- Ran `pnpm dev sync --no-folders --no-delete --limit 5 --watch --watch-interval 1`.
- Worker log confirmed the exact no-folder request repeated on interval:
  - baseline watched run fetched `5`, stored `5`, and reported `nextToken=present`
  - later cycles re-fetched the same top `5` visible all-bookmarks items and stored `0 new`
  - no delete calls occurred during the watched `--no-delete` runs
- After adding a new all-bookmarks item with no folder, the next watch cycle:
  - fetched `5`
  - stored `1 new`
  - preserved the bookmark on X
- A second newly added item also appeared on the next watched cycle as `1 new`, then subsequent cycles returned to `0 new` once the visible top `5` stabilized.
- This confirms:
  - no-folder watch repeats the exact no-folder request shape on interval
  - `--limit 5` constrains each watched run to a small visible all-bookmarks window
  - newly added bookmarks can enter that watched window on the next cycle
  - `--no-delete` preserves those bookmarks on X during watched no-folder runs
