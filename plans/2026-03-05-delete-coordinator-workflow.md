# Plan: Delete Coordinator Workflow

**Status:** In Progress
**Created:** 2026-03-05
**Source:** Follow-up from `--no-folders` sync investigation and Sync Orchestrator design

## Plan

**ADR:** `docs/adr/031-delete-coordinator-workflow.md`

### Context

Delete coordination is now doing two jobs at once:

- It is a **safety mechanism** that ensures bookmarks are only removed from X after they have been stored locally.
- It is also acting as an implicit **control-flow mechanism** for folder sync, because folder pagination only advances after deletes clear the currently visible bookmarks.

Those are related, but not identical, concerns.

Folder sync and no-folder sync need different delete behavior:

- **Folder sync** needs delete completion to unblock the next fetch cycle.
- **No-folder sync** does not need delete completion to continue fetching; it can fetch and store full bookmark pages independently, then drain deletes afterward.

Today, both modes share the same broad engine shape, which pushes delete-first behavior deeper into the common path than no-folder sync strictly needs.

### Goals

- Introduce a shared delete coordination model that both sync types can use.
- Preserve the core safety rule: **store first, delete second**.
- Support both synchronous and asynchronous delete handling without duplicating delete logic.
- Keep folder sync behavior compatible with the current drain model.
- Let no-folder sync evolve toward bounded-memory page-by-page `fetch -> store` cycles without being blocked on delete throughput.

### Non-Goals

- Supporting multiple simultaneous syncs right away.
- Building a full priority scheduler for competing delete producers in the first pass.
- Designing fairness/preemption rules between competing delete producers in this pass.
- Replacing the Sync Orchestrator plan; this plan complements it.
- Changing current `folder_id IS NULL` delete scope semantics unless a later implementation proves that necessary.
- Folding proactive no-folder fetch shaping into the blocking/background delete follow-up.

### Proposed Model

Introduce a shared **DeleteCoordinator** abstraction with two execution modes:

- `blocking`
  Used by folder sync when it must wait for a scope to drain before the next fetch cycle.
- `background`
  Used by no-folder sync when it can enqueue delete work and continue or finish without waiting.

The same coordinator owns:

- delete queue reads/writes
- retry and backoff behavior
- rate-limit handling
- logging and progress reporting

This keeps delete policy centralized while allowing different callers to choose whether they must wait for completion.

### Why Separate This From Sync Orchestrator

The Sync Orchestrator is about **which sync runs next**.

The Delete Coordinator is about **how deletes are drained once sync work has produced eligible bookmarks**.

They will likely integrate closely, especially once blocking/background behavior exists, but they are distinct concerns:

- orchestrator: sequencing sync requests
- delete coordinator: sequencing delete work

Keeping them in separate plans should make both designs easier to reason about and easier to implement incrementally.

### Expected Behavior By Sync Type

#### Folder sync

- Before each fetch cycle, request a `blocking` delete drain for the relevant scope.
- Wait until deletes have progressed enough for the next folder fetch to be meaningful.
- Fetch/store the next visible batch.
- Repeat.

This preserves the current operational contract: delete completion is part of pagination progress.

#### No-folder sync

- Fetch a bookmark page.
- Store that page immediately.
- Continue page-by-page until the requested limit or endpoint exhaustion.
- Hand off eligible deletes in `background` mode, or drain them sequentially after fetch/store completes through the same coordinator surface.

This keeps fetch/store fast and bounded while still reusing the same delete machinery.

### Development Path

#### Stage 1: Page-by-page no-folder fetch/store

Do this **before** introducing the coordinator abstraction.

Reason:

- It is the immediate product improvement.
- It reduces memory pressure right away.
- It clarifies what delete coordination actually needs to coordinate.

This stage should keep current delete semantics functionally the same wherever possible.

#### Stage 2: Extract a shared delete coordination interface

Refactor current delete execution behind a shared surface without changing behavior yet.

Example shape:

- `drainDeletes({ scope, mode: 'blocking' | 'background' })`
- or separate submit/wait operations if that fits Temporal better

At this stage, the implementation may still run inline while the interface solidifies.

Important guardrail for Stage 2:

- normal runtime paths should keep current delete semantics unless a smaller follow-up is explicitly approved
- in particular, no-folder sync should not switch to true background delete handoff during Stage 2 just because the interface now supports `background`
- preserve the live-validated delete-reveal fallback for suspicious terminal all-bookmarks pages (`limit=100` -> `94`, `nextToken=none`) while the interface is being extracted

#### Stage 3: Promote to a dedicated delete workflow/lane

Once the interface is stable:

- move delete draining into a dedicated workflow or worker lane
- support both `blocking` and `background` semantics through the same contract
- keep folder sync able to wait synchronously
- allow no-folder sync to hand off deletes asynchronously when appropriate

This is the point where close integration with the Sync Orchestrator will matter most.

### Design Questions To Settle Later

- Should the coordinator be a singleton lane from day one, or only once concurrent sync becomes necessary?
- What is the cleanest Temporal contract for `blocking` vs `background` behavior: signals, child workflows, or activity-backed queue ownership?
- Should folder sync be able to preempt background no-folder deletes in the future?
- How much status/progress should the CLI expose once delete work can outlive the calling sync?

### API Oddities To Explore

Live no-folder testing showed two important behaviors:

- the all-bookmarks endpoint can still return a false terminal page (`94` items, `nextToken=none`) for `limit=100`
- the current delete-reveal fallback can recover that case, but only by waiting for delete completion before refetch

By "fetch shaping" here, we mean proactively changing how no-folder fetches are requested so we avoid
known bad API behavior before fallback is needed. Examples:

- cap per-request all-bookmarks fetch size below a bad threshold
- split a large requested limit into smaller fetch segments
- let orchestration choose safer request sizes without changing the user-facing overall limit

That suggests a few coordinator-specific questions worth exploring later:

- Can no-folder sync stay in `background` delete mode normally, but temporarily escalate to `blocking` when a suspicious terminal page needs delete-reveal to make progress?
- Should folder-sync delete work preempt no-folder background drains, since folder pagination is directly unblocked by delete completion?
- Do we want the coordinator to expose a stronger notion of “delete enough to reveal more” instead of only “drain everything”?
- Shared X delete-bucket contention is now confirmed operationally, so coordinator scheduling may matter earlier than expected even if concurrent sync remains limited.

These are worth exploring, but still out of scope for the first real blocking/background implementation.

### Deferred After Full Ownership

The later full-ownership follow-up landed, so Temporal delete execution now flows through the coordinator for:

- backlog-before-fetch delete in `blocking`
- folder current-batch delete in `blocking`
- no-folder current-batch delete in `background` or `blocking`, depending on whether delete-reveal is needed

That shifts the remaining question to a narrower one:

- do we want stronger active-job preemption so a newly queued `blocking` folder delete can interrupt an already running `background` no-folder delete, or is queued priority enough for now?

This should be treated as deliberate future policy work, not as part of the ownership cleanup itself.

### Recommended Scope For First Implementation

Keep the first real implementation intentionally narrow:

- no-folder sync moves to page-by-page `fetch -> store`
- delete execution is wrapped behind a coordinator-friendly interface
- runtime behavior remains effectively single-sync and simple
- `background` mode may exist at the interface level, but Stage 2 does not need to activate it for normal sync execution yet

Then add dedicated blocking/background workflow behavior only after the simpler shape is working end to end.

Track that Stage 3 work separately so the future runtime switch is scoped and reviewable on its own.
