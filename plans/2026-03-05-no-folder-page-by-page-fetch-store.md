# Plan: No-Folder Page-By-Page Fetch-Store

**Status:** Complete (follow-up observability still open)
**Created:** 2026-03-05
**Source:** Follow-up from `--no-folders` investigation, dry-run testing, and delete-coordinator discussion

## Plan

### Context

`--no-folders` uses the all-bookmarks endpoint, which is materially different from folder sync:

- it returns **full tweet data**
- it supports **real cursor pagination**
- it does **not** require delete completion to reveal the next cursor page

That makes the current execution shape less than ideal for no-folder runs.

Today, a no-folder sync still goes through the shared engine path:

1. optional backlog delete
2. fetch all visible cursor pages into memory
3. store the accumulated batch
4. trigger child workflows
5. delete or enqueue the fetched bookmarks

This works, but it has two downsides:

- fetched data is buffered in memory until store begins
- if the endpoint stops returning `nextToken` before the X app appears drained, the current run has no built-in fallback beyond “stop here”

We observed exactly that second case in testing: a dry-run returned `94` bookmarks with `nextToken=none`, even though the X iOS app appears to show many more bookmarks.

### Current Outcome

Implemented:

- no-folder non-dry-run sync now runs page-by-page `fetch -> store -> process`
- local and Temporal paths both use the new cursor runner
- when X stops returning `nextToken` before the run budget is exhausted, delete-enabled no-folder sync now falls back to delete-reveal and restarts from the top
- that fallback now applies both to unbounded runs and to explicit `--limit N` runs that still have remaining budget

Still open:

- a dedicated anomaly/warning path for suspicious terminal no-folder pages
- any broader delete-coordinator refactor

### Key Clarification: Canary Scope

The current limitation canary does **not** inspect all sync runs.

Today it only watches **folder limitations**:

- folder bookmarks response returns full data
- folder bookmarks response starts returning `nextToken`
- folder list response starts returning `nextToken`

It does **not** inspect no-folder bookmark responses. That is intentional: the canary is for passive detection that a **documented folder limitation may have been lifted**, not for general pagination diagnostics.

So the no-folder `94 + nextToken=none` case should be handled as sync runtime behavior and observability, not as a canary rule.

### Goals

- Move no-folder sync to bounded-memory page-by-page `fetch -> store`.
- Keep `store first, delete second` as the safety invariant.
- Keep folder sync behavior unchanged.
- Reuse as much shared sync code as practical.
- Add a fallback drain behavior for delete-enabled no-folder runs when cursor pagination stops but the visible window may not be fully drained.

### Non-Goals

- Redesigning delete coordination in this change.
- Changing folder sync to use the no-folder flow.
- Introducing run-scoped delete manifests.
- Expanding the limitation canary to all bookmark endpoints.

### Desired Runtime Shape

#### Folder sync

No change for now:

- delete/backlog handling remains part of pagination progress
- fetch/store/delete continues as the existing drain cycle

#### No-folder sync with `--dry-run`

Keep current fetch-only behavior, but make pagination visibility explicit.

No delete-reveal fallback should run in dry-run mode.

#### No-folder sync with `--no-delete`

Run page-by-page:

1. fetch one API page
2. store that page immediately
3. enqueue deletes for that page
4. continue with `nextToken` if present

Stop when:

- `--limit` is reached, or
- `nextToken` is absent

No delete-reveal fallback should run in `--no-delete` mode, because older hidden bookmarks cannot be surfaced without actual deletes.

#### No-folder sync with deletes enabled and `--limit N`

Run page-by-page:

1. fetch one API page
2. store immediately
3. trigger child workflows as needed
4. delete that page's bookmarks
5. continue with `nextToken`

If `nextToken` disappears before the `--limit` budget is exhausted:

1. treat that as suspicious
2. finish store/delete for the current page
3. restart from the beginning
4. keep going until either the limit is reached, a fresh cycle returns `0`, or progress stalls

With an explicit limit, `--limit` remains a **fetch cap**, not a hard delete cap.

#### No-folder sync with deletes enabled and **no limit**

This is the new drain mode.

Primary behavior:

1. fetch one API page
2. store immediately
3. trigger children
4. delete that page
5. continue with `nextToken` while available

Fallback behavior when a visible cursor window ends:

- if a page fetched bookmarks but returns `nextToken=none`
- and deletes are enabled
- and the run still has remaining budget

then treat that as the end of the current visible window, not necessarily the end of all available bookmarks:

1. finish store/delete for that page
2. start a fresh fetch cycle from the beginning
3. continue until a fresh cycle returns `0` bookmarks, or until deletes make no progress

This gives no-folder sync a folder-style reveal fallback only when it is actually useful.

### Why This Shape

This keeps the best part of no-folder sync:

- fast fetch/store that is not blocked by delete rate limits on every single request

while adding the missing operational safety:

- bounded memory
- immediate persistence
- recovery path when the endpoint appears to expose only a partial visible window

### Suggested Implementation Strategy

Avoid a giant engine rewrite.

Instead, make no-folder paging an orchestration concern first:

- each outer “page” for no-folder sync should correspond to **one all-bookmarks API page**
- store/process that page immediately
- carry forward the returned `nextToken`
- when drain fallback is needed, reset the token and start a new visible-window cycle

This can likely be done with smaller changes than teaching the current fetch phase to stream partial batches through the engine mid-run.

### Implementation Steps

#### Step 1: Add no-folder page state to sync results/runner metadata

Expose enough information after each page run to decide what happens next:

- returned `nextToken`
- whether the current page exhausted its visible cursor window
- whether deletes made progress

This may belong in `SyncResult`, page runner metadata, or both.

#### Step 2: Add a dedicated no-folder paged execution path

For `--no-folders` non-dry-run runs:

- fetch at most one API page per engine invocation
- store that page immediately
- process that page immediately
- then decide whether to continue with:
  - returned `nextToken`
  - drain fallback restart
  - stop

Folder sync should remain on the existing path.

#### Step 3: Preserve current child workflow behavior

After each stored page:

- trigger enrich only if stubs exist
- trigger media download only if downloadable media exists

This keeps no-folder sync operationally close to folder sync and avoids regressing background processing.

#### Step 4: Add drain fallback for delete-enabled no-folder runs with remaining budget

When all of the following are true:

- `noFolders === true`
- `dryRun === false`
- `noDelete === false`
- either `limit === undefined` or the current run still has remaining limit budget
- current page fetched `> 0`
- current page returns `nextToken === undefined`

then:

- if deletes succeeded, restart from the beginning
- if deletes did not succeed, stop with the existing no-progress protection

This fallback should be disabled for dry-run and `--no-delete`, but should remain available for explicit `--limit N` runs while budget remains.

#### Step 5: Improve observability

Log enough context to understand why a no-folder run stopped:

- `nextToken=present|none`
- whether stop happened because of explicit limit, visible-window exhaustion, empty rerun, or no-progress
- whether a drain fallback restart was triggered

This should be plain sync logging/status, not limitation canary output.

### Implementation Notes

- The current implementation fingerprints the visible terminal page and stops with no-progress if the same visible window repeats after a restart.
- The current implementation intentionally does **not** send suspicious no-folder terminal pages through the limitation canary. If we want alerting here, it should be a separate anomaly signal using similar channels, not a reuse of the existing “limitation may be fixed” detector.

#### Step 6: Tests

Add focused tests for:

- page-by-page no-folder store/process
- no-folder limited run follows returned `nextToken`
- no-folder unlimited run restarts after terminal `nextToken=none`
- unlimited run stops when restart returns empty
- unlimited run stops on no-progress if deletes fail
- dry-run and `--no-delete` do not use the restart fallback
- folder sync behavior remains unchanged

### Files Likely In Scope

- `src/lib/sync-engine/types.ts`
- `src/lib/sync-engine/sync-engine-core.ts`
- `src/lib/sync-engine/engine/phases/fetch.ts`
- `src/lib/sync-runner/page-loop.ts`
- `src/lib/sync-runner/stop-reason.ts`
- `src/commands/sync/bookmarks/local/run.ts`
- `src/commands/sync/bookmarks/local/output.ts`
- `src/commands/sync/bookmarks/local/summary.ts`
- `src/temporal/workflows/sync/page-runner.ts`
- `src/temporal/shared/sync-types.ts`
- relevant local and Temporal sync tests

### Recommended Implementation Order

1. land the no-folder page-by-page execution path
2. land the unlimited drain fallback restart
3. tighten stop-reason/output wording
4. then revisit delete coordination as a separate follow-up

This keeps the code changes incremental while moving directly toward the runtime shape we want.
