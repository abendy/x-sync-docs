# Task: Sync Orchestrator + Delete Coordinator Live Test Checklist

**Status:** Complete (Chunks 2+5 deferred — no no-folder delete runs while folders hold data, pending classifier layer or full folder-first drain)
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

## Final Outcome (2026-08-04)

Live testing ran March 2026 (Sessions 1-5) and resumed 2026-08-03/04 after a 5-month idle gap (Sessions 6-8). Everything runnable passed; the full evidence trail is in the per-chunk annotations and Session Log below.

**Verified green (live, against the real account):** orchestrator serialization; queue dedup + priority promotion; `--next` and `--next --watch` urgency incl. urgent repeats; folder/no-folder/discovery watch mechanics (discovery via pause-snapshot: 133 folders enqueued, zero executed); active-duplicate behavior (recorded, acceptable); coordinator ownership of all delete phases; durable rate-limit pause/resume (~50 deletes per 15-min window measured); coordinator pause/resume mid-drain; worker restart mid-pause (timer survived); continue-as-new at child #50 with full state carry-over. Soak: 1,406 bookmarks synced, ~850 deletes, 0 failures across ~17 quota windows.

**Regressions found + fixed during Session 6-7 testing:**

- `4217086` — Temporal backlog delete jobs were a silent no-op (empty `bookmarks: []` treated as explicit scope) since 2cd4879.
- `dff7fdd` — coordinator fast-failed every queued delete on 429 instead of pausing durably (missing `extractRateLimitResetAt` unwrapper).

**Landed alongside (via external worker agents):** `b3732cc` `workflow watch-stop` CLI; `ada31e9` hermetic test logging.

**Deferred (the only open items):** Chunks 2+5 (no-folder edge path + overlap). Hard gate set by owner 2026-08-04: **no no-folder delete-enabled runs while any folder holds live bookmarks** — folder grouping must survive until a classifier layer exists. Run plan is documented in the Chunk 2 section, ready when the gate opens.

**Optional follow-ups recorded (neither urgent):** orchestrator active-run enqueue guard (Chunk 4 verdict); orchestrator error aggregation (single `Last Error` line hid ~80 failures during the storm).

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

## Current Status (revised 2026-08-04)

Project was idle ~5 months after Session 5. Reality has changed:

- The account has accumulated a large live backlog (dozens of bookmarks/week since March) — likely 300+, possibly past the ~800 API window. Data volume is no longer the constraint; the real backlog is the test bed.
- The local DB view is stale (9 live bookmarks recorded locally). A recon pass is needed before trusting any local counts.
- Landed since the March sessions: all Temporal delete phases route through `delete-coordinator` (2cd4879), child-counter reset on continue-as-new (d35369a), better-sqlite3 major bump, `pnpm dev backup` command (6c9cef3).
- Code re-verified 2026-08-03: the two "not yet" caveats in Expected Behavior above still hold (no active-run enqueue guard in the orchestrator; no active-job preemption in the delete coordinator).
- The March "Blocker: folder sync work should be finished first" notes are cleared — that work completed 2026-03-07. The ordering discipline itself still stands, restated below.

### Rules of engagement (live account)

- **HOLD (owner, 2026-08-05): all work and testing paused until the in-flight work branches merge** (notably `topic/archive-safety`). Chunk 7 items 2-5 do not proceed until the owner lifts the hold. Delete-enabled runs thereafter require a fresh, explicit per-session go naming the folder — prior standing approvals are expired.

- **Backup before every delete-enabled session**: `pnpm dev backup` (writes to `./data/backups/`).
- **All proper live runs are folder syncs until folders are fully drained.** Delete is global and a no-folder sync does not preserve which folder a post was saved under — a no-folder delete run can destroy folder membership that was never archived. No-folder usage before then is limited to `--dry-run` / `--no-delete` recon. Delete-enabled no-folder runs (Chunks 2+5) come only after folder drains are complete.
- **Audit `delete_queue` before the first delete-enabled run** — it holds 5-month-old queued deletes that the backlog phase will fire immediately.
- Use `--no-delete` for ordering/queue assertions (Chunks 3/4); spend real deletes only where deletion is the subject (Chunks 2/5).
- Draining hundreds of backlogged bookmarks means hundreds of rate-limited delete calls — plan long sessions.
- **Once the safety-layers branch merges** (Mini worker: `X_BOOKMARKS_DB` + `archive_role` marker): `pnpm dev archive mark` on the live DB becomes the mandatory first step of every delete-enabled session — an unmarked DB silently degrades all syncs to `--no-delete` with a warning. Until it merges, nothing changes. Prefer merging it between sessions, adding the mark step to Chunk 0 in the same commit of this doc.
- Litestream now replicates the live DB continuously (MBP LaunchAgent → rsync.net). Keep the `pnpm dev backup` pre-session habit regardless — instant local rollback needs no network.

### Revised execution order

1. **Chunk 0: Re-baseline** (new, below) — env bring-up, auth check, state audit, backup, recon.
2. **Chunk 3 + 4 remainder** — real folder syncs (delete-enabled drain), `--next --watch` and mid-flight duplicate enqueue observed against naturally long runs; pause-snapshot (Session 3 technique) as fallback if runs turn out short.
3. **Chunks 2 + 5 merged** — no-folder delete-enabled runs against the real unfoldered backlog; Chunk 2 reframed as observational (record whether the suspicious terminal page reproduces and whether the limitation canary fires; do not block Chunk 5 on reproduction).
4. **Chunk 6: Durability** (new, below) — continue-as-new, worker restart, coordinator pause/resume mid-drain, folded into the above runs rather than separate API-spending runs.

### Status at end of Session 7 (2026-08-04, ~02:45)

- Done: Chunk 0, Chunk 1 (revalidated), Chunk 3 (all but discovery watch), Chunk 4 (all, verdicts recorded), Chunk 6 worker-restart + coordinator pause/resume. Two regressions found+fixed+verified live (4217086 backlog no-op, dff7fdd rate-limit fast-fail). `watch-stop` CLI landed (b3732cc) and test-log hermeticity fixed (ada31e9) via external worker agents.
- Self-executing: 7-folder drain (2 done: IMMIGRATION, DEVELOPER ENVIRONMENT; Finance active; NY/Covid/AI/IDE queued). CAN test armed — `IMMIGRATION --no-delete --watch-interval 1` subscription will accumulate ~1 child/min once the drain queue empties; CAN fires at child #50; verify with `temporal workflow describe`/history, then `workflow watch-stop`.
- Residual analysis — delete_queue backoff (2s base, 30s cap) vs 15-min rate-limit windows: miscalibrated only for 429s, and post-dff7fdd no 429 reaches `recordDeleteFailure` on either the Temporal or local path (both detect and pause). Storm rows (attempts 1-4, next_attempt_at long past) drain via their folders' backlog phases. Verdict: no change needed; revisit only if a 429 ever surfaces in `last_error` again.
- Gated on drain completion: Chunks 2+5 (no-folder delete-enabled runs — unsafe until all folder membership archived, since all-bookmarks delete can hit foldered items). Run plan when unblocked: backup first; `sync --no-folders --limit 100` (Chunk 2 observational + canary); while its background delete drains, enqueue a folder sync and record overlap behavior (Chunk 5); fold in `workflow status delete-coordinator` usefulness notes.
- Parked for owner sign-off: discovery watch (`sync --watch`) — enqueues delete-enabled syncs for ALL visible folders, beyond the approved 7.

### Recording template for "observe and decide" items

For each: **Observed** / **Expected** / **Verdict (acceptable | follow-up)** / **Follow-up task link if any**.

## Live Checklist

### Chunk 0: Re-baseline After Idle Period (added 2026-08-04)

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass on current `develop`
- [x] Auth still valid (tokens may have expired over 5 idle months); re-auth if needed
- [x] Audit `delete_queue` contents; record and decide keep-or-clear before any delete-enabled run
- [x] `pnpm dev backup` completes; `pnpm dev status` reminder clears
- [x] Temporal server + worker up; no stale workflow executions surprising us
- [x] Recon: size the live backlog (dry-run / small `--no-delete` fetch + folder list refresh); record live counts vs stale local view
- [x] Smoke re-run of one small Chunk-1-style folder sync to revalidate the March checkmarks against the current code
  - Found + fixed a real regression: Temporal backlog delete phase was a silent no-op since 2cd4879 (see Session 6)

### Chunk 1: Baseline Regular Sync

- [x] Run one regular folder sync through `pnpm dev sync <folder>`
- [x] Confirm it starts `sync-orchestrator`
- [x] Confirm it starts one child `sync-orchestrator-sync-*`
- [x] Confirm folder delete runs through `delete-coordinator`
- [x] Confirm enrich/media behavior still looks correct when applicable
- [x] Run one regular no-folder sync through `pnpm dev sync --no-folders --limit <small>`
- [x] Confirm normal no-folder delete handoff goes to `delete-coordinator`
- [x] Confirm `workflow status delete-coordinator` is useful during the run

### Chunk 2: No-Folder Edge Path (DEFERRED 2026-08-04 — see gate below; runs merged with Chunk 5)

**Gate (owner decision, 2026-08-04): no no-folder delete-enabled runs while any folder holds live bookmarks.** Folder grouping must be preserved until a classifier layer exists to recover it. Unblocks when either (a) the classifier layer lands, or (b) all visible folders have been drained folder-first. Run plan below stays ready.

Reframed 2026-08-04: after 5 months of API drift, do not assume the March quirk reproduces. Run against the real unfoldered backlog **only after folder syncs have drained** (see rules of engagement).

- [ ] Run `pnpm dev sync --no-folders --limit 100`
- [ ] Record whether the suspicious `100 -> short page + no nextToken` terminal page reproduces; note any limitation-canary observations either way
- [ ] If reproduced: confirm no-folder delete escalates to `blocking` when delete-reveal is needed
- [ ] Confirm final fetched/stored/deleted counts still make sense

### Chunk 3: Priority + Watch

- [x] Run `pnpm dev sync <folder> --next`
- [x] Confirm it queues ahead of normal work
- [x] Run `pnpm dev sync --watch`
- [x] Confirm discovery watch refreshes visible folders and re-enqueues them
  - Session 8: verified via pause-snapshot (coordinator paused as backstop, orchestrator paused ~150ms after signalWithStart, before its startup refresh finished). Discovery refresh fetched and enqueued **133 visible folders**; `Completed Children: 0` — nothing executed; orchestrator cancelled to discard the queue, coordinator resumed (0 orphaned jobs). Interval *repetition* of discovery not observed live (30-min default; same per-subscription scheduler as the request watches verified in Sessions 4/5/7).
- [x] Run `pnpm dev sync <folder> --watch`
- [x] Confirm the exact folder request repeats on interval
- [x] Run `pnpm dev sync --no-folders --watch`
- [x] Confirm the exact no-folder request repeats on interval
- [x] Run `pnpm dev sync <folder> --next --watch`
- [x] Confirm each repeat stays urgent, as currently designed (Session 7: initial IMMIGRATION child and its 1-min watch repeat both ran `[urgent]`, jumping the normal queue)

### Chunk 4: Queue Behavior

- [x] Queue multiple different folder syncs
- [x] Confirm they run one at a time in expected priority order
- [x] Queue the same folder sync twice while it is still queued
- [x] Confirm it is deduped or promoted instead of duplicated
- [x] Queue the same folder sync again while it is already running
- [x] Observe current behavior and record it explicitly
- [x] Decide whether the current behavior is acceptable or should become a follow-up task
  - **Observed**: duplicate of the actively running AI request was enqueued as a second `[normal]` queue entry; after the active run completed it ran as its own child, re-fetched the same page, `new=0`, `stop=no-progress` (~11s wasted, no data harm).
  - **Expected**: matches the documented "no active-run guard" caveat exactly.
  - **Verdict**: acceptable for now — self-healing and cheap. Optional follow-up: dedupe/ignore enqueues matching `state.currentRequest` (or treat as promote-only), low priority.

### Chunk 5: Overlap / Operational Reality (DEFERRED 2026-08-04 — same gate as Chunk 2)

- [ ] Start a no-folder sync that hands delete off in `background`
- [ ] While background delete is still draining, enqueue a folder sync
- [ ] Confirm what happens in practice:
  - sync serialization
  - delete-coordinator queue order
  - whether folder progress is delayed behind active background delete
- [ ] Record whether current behavior is acceptable for now

### Chunk 6: Durability (added 2026-08-04)

Fold these into Chunk 2-5 runs rather than spending separate API calls.

- [x] Continue-as-new: drive the orchestrator across a continue-as-new boundary with queued work and/or an active watch subscription; confirm queue, watch state, and child counters survive (d35369a regression check)
  - Session 8: CAN fired at exactly child #50 (threshold), new run kept RUNNING. Verified post-CAN: watch subscription intact (1-min interval), Completed Children reset and counting fresh (the d35369a fix), Total Synced 1406 carried, Recent Children spanning the boundary (old-run sync-50 → new-run sync-1/2), child IDs restarting without collision. PASSED.
- [x] Worker restart: kill the worker mid-sync; restart; confirm the sync resumes and completes without data loss (Session 7: killed mid-rate-limit-pause; restarted worker replayed both singletons with timer/counters/queue intact and the durable timer fired on schedule at 01:21:57)
- [x] Delete-coordinator control: `workflow pause delete-coordinator` mid-drain, confirm the drain halts; `resume`, confirm it continues; status output stays truthful throughout
  - Session 7 (01:37): paused mid-active-window — deletes stopped at the in-flight item (05:37:15), verified 15s+ of silence; status correctly showed execution `RUNNING` / progress `paused` with truthful counters (130 deleted). Resume → deletes flowing again within ~1s, status `running`. PASSED.

### Chunk 7: Intake from import/origin + Litestream work (added 2026-08-05)

Context: `feat(import)` merged (PR #11 + `f7034b4`, ADR 034 — `bookmarks.origin` gates all three delete feeds); Litestream replication live on the MBP (`.project/plans/2026-08-05-litestream-rsync-net.md`). Fold these into the next session's runs — only item 3 spends deletes, and those were being spent anyway.

- [x] **First app open migrates the schema**: nothing has opened the live DB through the app since the merge, so the first CLI/worker start adds `bookmarks.origin`. Afterwards: `PRAGMA table_info(bookmarks)` shows `origin` default `'sync'`, and the Litestream log advances txid on the change.
  - Session 9 (2026-08-05): PASSED. Pre-migration raw-sqlite snapshot taken first (`data/backups/bookmarks-premigration-20260805.db`); observed first open was `pnpm dev status` — `origin TEXT NOT NULL DEFAULT 'sync'` added, all 12,628 rows backfilled `'sync'`, Litestream txid advanced 01→02 in replica lockstep on the change. Items 2-4 not attempted (owner paused testing); nothing else mutated — no infra started, no imports, no syncs.
- [ ] **Backlog phase revalidation post-origin-guard**: three delete-feed queries now carry `origin != 'import'`; all pre-existing rows default `'sync'`, so the first drain's `Backlog ready: N` must match the `delete_queue` audit exactly (Session-6 lesson: smoke the changed SQL, don't trust old green checkmarks).
- [ ] **Import acceptance ride-along** (closes the import plan's last box): import two links into a folder about to be drained — one that IS a live X bookmark in that folder, one that isn't. Expected: the non-bookmark import survives the whole drain (`origin='import'`, never queued, zero quota); the real one is re-observed by the fetch, flips to `'sync'`, and drains normally. Note: imports never appear in `folder-sync-report` "new" counts (it keys on `sync_log`).
- [ ] **Litestream soak** (closes the durability plan's open box): during drains, worker logs show no `database is locked`; litestream log stays in txid lockstep through delete storms; `data/bookmarks.db-wal` drains rather than growing unboundedly (litestream owns checkpointing now).
- [ ] **Safety-layers sequencing decided explicitly** when the Mini worker's SHA arrives — see rules of engagement.

## Notes To Capture While Testing (answered 2026-08-04, Sessions 6-8)

- **Whether CLI output clearly tells the user who owns current work** — Mostly yes. Sync children correctly show no delete counts post-refactor (ownership moved), and `delete-coordinator` status shows queue/progress/cumulative counters. One gap: the orchestrator surfaces only a single `Last Error` line even when ~80 deletes failed (observed during the storm) — recorded as optional follow-up (error aggregation).
- **Whether the two `workflow status` commands are enough without Temporal Web** — Yes, throughout. Temporal Web was never opened across three sessions. Status even surfaces the pending rate-limit reset time after a worker restart. Raw `temporal workflow show/describe` was used only for history-level verification (idle-park check, CAN runId rollover) — reasonable for test forensics, not needed operationally.
- **Whether worker logs feel informative without being noisy** — Informative; per-delete INFO lines are high-volume but greppable, and the JSONL file format works well for tailing. The only true noise was the (since-fixed) fast-fail storm. Post-fix, one pause WARN per quota window is exactly right.
- **Any surprising queue duplication or watch-repeat behavior** — None beyond the documented no-active-run-guard duplicate (Chunk 4, verdict: acceptable). Dedup, promotion, urgent ordering, and watch repeats all behaved to spec in live runs.
- **Any friction from the lack of active-job preemption** — Not observed as real friction in these sessions; blocking jobs consistently outranked queued background work. The direct probe (folder sync arriving mid-background-drain) is part of deferred Chunk 5, so this stays a residual unknown rather than a confirmed non-issue.

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

### Session 6 (2026-08-04) — Chunk 0 re-baseline

- Toolchain: `pnpm lint`, `pnpm typecheck`, `pnpm test` all green on `develop` (471 tests) after the backup-command and pnpm-workspace commits (b1e65f8, 6c9cef3).
- Auth: `pnpm dev auth verify` succeeded — OAuth refresh worked after 5 idle months.
- `delete_queue` audit: 7 rows, all from 2026-03-07/08, `attempts=0`, no errors — 2 in `IDE`, 5 unfoldered. These are the `--no-delete` backlog from Sessions 4/5 (including the test bookmarks added from the iOS app). All already archived locally. **Decision: keep** — draining them on the next delete-enabled run is the designed backlog-clear behavior.
- Backup: `pnpm dev backup` wrote `data/backups/bookmarks-20260804T042347Z.db`.
- Temporal: dev server restarted against the persisted `.temporal/temporal.db`. Only one execution still running: the `delete-coordinator` singleton (started 2026-03-07). History tail showed it idle-parked since 2026-03-07T23:26 with no in-flight work. Kept it, started the worker with current code, and the status query **replayed the 5-month-old history cleanly**: `idle, Queue: 0, Completed Jobs: 11, Total Deleted: 30, Total Failed: 0`. Bonus durability data point (Chunk 6): singleton survived a 5-month idle gap and a better-sqlite3 major bump.
- No orchestrator execution and no watch subscriptions survived — no surprise sync work on worker start.
- Recon: `sync --no-folders --dry-run --limit 10` fetched 10 with `completeness=full, nextToken=present` — a real multi-page live backlog exists, as expected from ~5 months of saves. Folder refresh from the API shows several folders created since March (IDs in the 2030+ range: WOKE, LEFT DELUSION, BLM, BLACKS...), so discovery-watch testing now has genuine folder churn available.
- Smoke run 1: `pnpm dev sync IDE --pages 1` — fetched/stored/enriched 20, media 8, current-batch deleted 20 through the coordinator. **But the backlog job ran with 0 items and left the 2 queued IDE rows untouched.**
- Root cause: `page-runner.ts` submitted backlog jobs with `bookmarks: []`; `InlineDeleteCoordinator.resolveBookmarks` treated the empty array as an explicit scope (truthy `if (scope.bookmarks)`) and never called `getDeleteBacklog`. **Every Temporal backlog delete phase since 2cd4879 was a silent no-op.** March Chunk 1 checkmarks predated that refactor by hours; unit tests all mocked an empty backlog, so nothing caught it. This is precisely what the smoke re-run item existed to catch.
- Fix (4217086): empty list no longer counts as explicit scope; backlog submissions omit `bookmarks`; regression test added (backlog job with `bookmarks: []` must resolve via `getDeleteBacklog`).
- Operational note: the fix changes activity scheduling inside the coordinator, so the running singleton's history (containing the no-op backlog job) would non-determinism-error on replay. Terminated `delete-coordinator` (final counters: 13 jobs / 50 deleted / 0 failed) and restarted the worker on fixed code. **Policy going forward: behavior changes to coordinator/orchestrator workflow code require terminating the affected singleton in dev.**
- Smoke run 2 (fixed code): `Backlog ready: 2 queued deletes` → both March test bookmarks deleted from X; current-batch deleted the next 20. Final: `delete_queue` 7 → 5 (only unfoldered rows remain, correctly out of scope for a folder sync), fresh coordinator `2 jobs / 22 deleted / 0 failed`, enrich 20/20, media 9, no failures.
- Chunk 0 complete. Next: Chunk 3/4 remainder on large folders (IDs from account owner).

### Session 7 (2026-08-04) — Chunk 3/4 on approved folder drains

Approved folders (historical local totals): IDE (1001), AI (713), Covid (514), NY (479), Finance (181), DEVELOPER ENVIRONMENT (59), IMMIGRATION (4).

- **Discovery watch deferred**: code check confirmed `refreshFolderQueue` enqueues a delete-enabled sync for **every** visible folder (`noDelete: false`) — running `sync --watch` authorizes draining the whole account, not just the approved list. Needs explicit owner sign-off; left unchecked.
- **UX finding**: the orchestrator supports `stopWatch` but no CLI command sends it — the only off-switch is cancelling the whole orchestrator. Flagged as a follow-up task. Workaround this session: `temporal workflow signal -w sync-orchestrator --name stopWatch`.
- Started uncapped AI drain, then while it ran: enqueued AI again (active duplicate), Covid (normal), Finance (`--next`).
- Queue snapshot with AI active:
  - `1473278992123846663 [urgent]` (Finance — enqueued last, placed first: `--next` confirmed against a live queue)
  - `1549512566451445762 [normal]` (AI duplicate — **enqueued as a second entry while the same shape was actively running**; confirms the no-active-run-guard caveat live)
  - `1471130970296303630 [normal]` (Covid)
- Started `IMMIGRATION --next --watch --watch-interval 1` — urgent watch subscription active; awaiting repeat observations.
- Priority/queue results (all confirmed from recent-children detail): execution order AI → Finance `[urgent]` → IMMIGRATION `[urgent]` → AI-dup `[normal]` → Covid `[normal]` → IMMIGRATION watch repeat `[urgent]`; one child at a time throughout; both IMMIGRATION children `[urgent]` — closes the `--next --watch` items. Active-duplicate observation recorded under Chunk 4.
- IMMIGRATION has ≥20 live bookmarks on X (local cache said 4) — live counts confirm the stale-local-view assumption.
- **Second regression found (fixed as dff7fdd)**: the AI drain exhausted the delete quota mid-run (~35 syncs in) and the coordinator **fast-failed every remaining queued delete at the rate-limiter pace** instead of pausing durably. Root cause: activities throw `RateLimitError`, which crosses the activity boundary wrapped as `ActivityFailure`→`ApplicationFailure`; the sync workflow ops carry the `extractRateLimitResetAt` unwrapper (`resolveRateLimitResetAt`) but the coordinator workflow ops never got it when delete ownership moved (a3af508/2cd4879). Detection failed → `withRateLimitRetry` treated 429s as plain failures → `recordDeleteFailure` per item → next. ~80 delete attempts burned as 429s; all children ended `stop=no-progress` (the drain loop's safety valve worked); `delete_queue` grew to 85 ready rows.
- Sync-side observations during the storm: children completed fast with `stop=no-progress` (correct bail-out); orchestrator surfaced only a single `Last Error` line for ~80 failures (observability gap worth noting); fetch/store/enrich/media unaffected (separate quota).
- Fix: added `extractRateLimitResetAt` to coordinator ops reusing `resolveRateLimitResetAt`; workflow-level regression test (wrapped RateLimitError → durable sleep + retry, no recorded failure). Stale coordinator singleton terminated again per the dev-mode policy; worker restarted.
- Stopped the IMMIGRATION watch via `temporal workflow signal -w sync-orchestrator --name stopWatch` (no CLI surface exists — see UX finding above).
- Re-enqueued all 7 approved folders (ascending size) **during** the rate-limited window as the live verification: the coordinator should pause durably until the 01:06:47 reset, auto-resume, and drain the 85-row backlog plus current batches.
- **Fix verified live**: first delete hit the 429 at 00:58:59 → exactly ONE `Rate limited until` line → durable ~8-min pause → auto-resume at 01:07:01 (reset + buffer) → drained IMMIGRATION's 20-row backlog + current batches → quota re-exhausted after exactly 50 deletes → ONE new pause line until 01:21:49. Before the fix the same situation produced ~80 fast-fail lines in 90 seconds. Failed-delete log lines total 2 (one per pause boundary — the probing item is retried after the wait, not recorded as failed; coordinator `Total Failed: 0`).
- **Measured delete quota: 50 per 15-min window (~200/hr)** — sets the wall-clock expectation for full drains; hundreds of live bookmarks per folder means many hours. Orchestrator/coordinator handle the cadence autonomously.
- Note for Chunk 6: the durable pause is a natural worker-restart test point (kill worker mid-pause, confirm the timer survives).
- **Chunk 6 worker-restart test (PASSED)**: killed and restarted the worker mid-pause (~01:10). Restarted worker replayed both singletons cleanly: coordinator paused with `Rate Limit Reset: 1:21:49 AM` intact and counters preserved (40 deleted / 0 failed), orchestrator queue of 6 + active child untouched. The durable timer then fired on schedule — backlog + current-batch jobs resumed at 01:21:57 (~8s after reset) on a worker process that did not exist when the timer was set. Status output surfacing the reset time post-restart is a nice observability win.

### Session 8 (2026-08-04 morning) — drain completion, CAN, discovery snapshot

- All 7 approved folders fully drained overnight: **1406 total synced**, coordinator soak ended at 847+ deletes / 0 failed across ~17 quota windows — sustained regression-green on both fixes.
- CAN test passed (details under Chunk 6): fired at exactly child #50, all state carried, counter reset correct.
- `workflow watch-stop` first real outing: listed the live IMMIGRATION subscription, cleared it, orchestrator completed cleanly.
- Discovery-watch mechanism verified via pause-snapshot (details under Chunk 3): **133 visible folders** enqueued, zero executed, clean teardown (orchestrator cancelled, coordinator resumed with 0 orphaned jobs).
- Recon: all-bookmarks dry-run still returns full pages with `nextToken=present` — remaining live bookmarks sit in ~126 unapproved folders plus unfoldered items.
- Remaining open: Chunks 2+5 only. Gate is now purely a scope decision: full-drain-first vs accept membership loss vs hybrid.
