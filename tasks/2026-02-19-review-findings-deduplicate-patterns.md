# Task: Review findings for deduplicate sync/workflow command patterns

**Status:** Complete
**Created:** 2026-02-19
**Completed:** 2026-02-19
**Source:** ~/.claude/plans/floofy-skipping-orbit.md
**Prior task:** [deduplicate-sync-workflow-command-patterns](./2026-02-19-deduplicate-sync-workflow-command-patterns.md) — original deduplication work; review findings at bottom spawned this task

## Commits

- [x] `refactor(temporal): separate client lifecycle from CLI exit policy` (0760f4d)
  - Added `TemporalUnavailableError` class to `src/temporal/client.ts`
  - Rewrote `withTemporalClient` to throw instead of `notify` + `process.exit`, dropped `errorLabel` param and catch block
  - Created `src/commands/shared/temporal.ts` with `withTemporalClientOrExit` CLI wrapper
  - Updated 4 call sites to use the new wrapper
  - Updated test mock in `sync-command-routing.test.ts`
- [x] `fix(sync): move startup output inside Temporal availability gate` (083dd38)
  - Moved `printWorkflowStartHeader` + console output inside `withTemporalClientOrExit` callback in `sync/bookmarks/temporal.ts` and `media-download.ts`
  - Output only prints after Temporal is confirmed available
- [x] `test(temporal): add withTemporalClient and polling-workflow-handler tests` (b155c51)
  - `tests/temporal-client.test.ts` — 6 tests: unavailability error, callback result, client passthrough, finally cleanup (success + failure), error propagation
  - `tests/polling-workflow-handler.test.ts` — 5 tests: missing option exit, ID generation, custom ID, input building, output ordering
  - Note: had to mock `@temporalio/client` primitives (Connection.connect, Client constructor) rather than same-module functions due to ESM binding limitations
- [x] `fixup! refactor(temporal): separate client lifecycle from CLI exit policy` (403bfa3)
  - Widened `try/finally` in `withTemporalClient` to cover the availability check — fixes connection leak when `isTemporalAvailable` connects successfully but health check fails
  - Added test: "closes the connection when health check fails after successful connect" (254 tests total)

## Plan

### Context

Three review findings from the deduplication work. Finding 1 (medium): `withTemporalClient` in `src/temporal/client.ts` mixes infrastructure and CLI concerns (`notify` + `process.exit`). Finding 2 (low): output prints before Temporal availability is validated, causing confusing UX when Temporal is down. Finding 3 (low): no tests for `withTemporalClient` failure paths or `createPollingWorkflowHandler` validation.

### Commit 1: `refactor(temporal): separate client lifecycle from CLI exit policy`

#### `src/temporal/client.ts` — make `withTemporalClient` throw instead of exit

- Add `TemporalUnavailableError` class (extends `Error`)
- Rewrite `withTemporalClient`:
  - Drop `errorLabel` param → signature becomes `withTemporalClient<T>(fn: (client: Client) => Promise<T>): Promise<T>`
  - Availability check throws `TemporalUnavailableError` instead of `notify` + `process.exit`
  - Remove `catch` block entirely — errors from `fn` propagate naturally
  - Keep `finally` block (close client)
- Remove `notify` import (no longer needed)

#### `src/commands/shared/temporal.ts` — new CLI-layer wrapper

Create `withTemporalClientOrExit<T>(errorLabel: string, fn)` following the `buildSingleCapabilityPlanOrExit` naming pattern already in `src/commands/shared/capability-plan.ts`.

#### Update 4 call sites — switch to `withTemporalClientOrExit`

1. `src/commands/sync/bookmarks/temporal.ts`
2. `src/commands/sync/media-download.ts`
3. `src/commands/workflow/start-command/register.ts`
4. `src/commands/workflow/list.ts`

#### Update test mock — `tests/sync-command-routing.test.ts`

### Commit 2: `fix(sync): move startup output inside Temporal availability gate`

Move output into `withTemporalClientOrExit` callback in `sync/bookmarks/temporal.ts` and `media-download.ts`.

### Commit 3: `test(temporal): add withTemporalClient and polling-workflow-handler tests`

- `tests/temporal-client.test.ts` — withTemporalClient failure paths
- `tests/polling-workflow-handler.test.ts` — createPollingWorkflowHandler validation

### Verification

1. `pnpm typecheck` — confirms all imports and signatures align
2. `pnpm lint` — no unused imports, ordering correct
3. `pnpm test` — all existing + new tests pass (253 total)
4. Manual: `withTemporalClient` in client.ts has zero imports from `lib/notifications.js` or calls to `process.exit`

## Feedback

## Action Items

## Notes

- Plan called for 3 commits; all 3 landed cleanly
- 253 tests pass (242 existing + 11 new) across all commits
- ESM module binding limitation required mocking `@temporalio/client` primitives rather than same-module functions for `temporal-client.test.ts`
- Biome caught formatting issues on `withTemporalClientOrExit` signature (line width) and import ordering (new import path sorting) — fixed before commit

## Re-Review Findings (2026-02-19)

1. **Medium** — ~~`withTemporalClient` can leave an open cached Temporal connection on the unavailable path. `isTemporalAvailable` may create and cache a client via `getTemporalClient` (`src/temporal/client.ts:66`) and then return `false` on list failure (`src/temporal/client.ts:71`) without closing it; `withTemporalClient` then throws before entering its `try/finally` cleanup block (`src/temporal/client.ts:84-93`). This creates a resource-lifecycle edge case and stale-client risk for non-exiting callers.~~ Fixed in 403bfa3 — widened `try/finally` to cover the availability check.
