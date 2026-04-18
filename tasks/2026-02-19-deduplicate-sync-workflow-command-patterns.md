# Task: Deduplicate sync/workflow command patterns

**Status:** Complete
**Created:** 2026-02-19
**Completed:** 2026-02-19
**Source:** ~/.claude/plans/agile-watching-graham.md
**Follow-up:** [review-findings-deduplicate-patterns](./2026-02-19-review-findings-deduplicate-patterns.md) — addresses the 3 review findings at the bottom of this file

## Plan

### Context

The duplication exploration identified four findings across the sync and workflow command surfaces. These create drift risk as the codebase evolves — changes to one entry point can miss the other. This plan addresses all four in three focused commits.

### Commit 1: `refactor(sync): use shared generateWorkflowId and output helpers`

Findings 1 + 4 combined. Single file change.

#### `src/commands/sync/bookmarks/temporal.ts`

1. **Delete** local `generateWorkflowId()` (lines 101–105)
2. **Import** `generateWorkflowId` from `../../workflow/shared.js`
3. **Change** call from `generateWorkflowId()` → `generateWorkflowId('sync')` (line 20)
4. **Import** `printWorkflowStartHeader`, `printWorkflowStarted` from `../../workflow/start-command/output.js`
5. **Replace** lines 55–57 (inline `sectionHeader` + Workflow ID + Task Queue) with `printWorkflowStartHeader('Starting Sync Workflow', workflowId, taskQueue)`
6. **Replace** lines 86–92 (inline success + monitor + control messages) with `printWorkflowStarted(workflowId, { showControls: true })`
7. **Remove** `sectionHeader` from the `notifications.js` import (keep `notify`)
8. Lines 58–76 (Folder, Capability Plan, mode flags, limit, pages) stay — sync-specific details

### Commit 2: `refactor(temporal): extract withTemporalClient lifecycle helper`

Finding 3. Adds helper to `client.ts`, adopts it in 4 straightforward call sites.

#### `src/temporal/client.ts` — add helper

```typescript
export async function withTemporalClient<T>(
  errorLabel: string,
  fn: (client: Client) => Promise<T>,
): Promise<T>
```

- Calls `isTemporalAvailable()` → `notify('error', ...)` + `process.exit(1)` if unavailable
- `try`: `getTemporalClient()` → pass to `fn` → return result
- `catch`: `notify('error', \`${errorLabel}: ${error.message}\`)` + `process.exit(1)`
- `finally`: `closeTemporalClient()`
- New import: `notify` from `../lib/notifications.js`

#### `src/commands/sync/bookmarks/temporal.ts` — adopt helper

- Replace availability check (lines 12–16) + try/catch/finally (lines 78–98) with:
  ```
  await withTemporalClient('Failed to start workflow', async (client) => { ... })
  ```
- Import changes: drop `closeTemporalClient`, `getTemporalClient`, `isTemporalAvailable`; add `withTemporalClient`. Drop `notify` (no longer used directly).

#### `src/commands/sync/media-download.ts` — adopt helper

- Same pattern. Drop `closeTemporalClient`, `getTemporalClient`, `isTemporalAvailable`, `notify`; add `withTemporalClient`.

#### `src/commands/workflow/start-command/register.ts` — adopt helper

- Same pattern. Drop `closeTemporalClient`, `getTemporalClient`, `isTemporalAvailable`, `notify`; add `withTemporalClient`.
- `resolveCycleOptions(options)` moves before the `withTemporalClient` call (no dependency on client).

#### `src/commands/workflow/list.ts` — adopt helper

- Same pattern. Drop `closeTemporalClient`, `getTemporalClient`, `isTemporalAvailable`; keep `sectionHeader` from `notifications.js` import but drop `notify`. Add `withTemporalClient`.
- Also standardizes the availability error message (was missing the `pnpm temporal:up` hint).

#### Deferred (not in scope)

- `workflow/control.ts` — missing availability check entirely (separate bug/concern)
- `workflow/status-command/register.ts` — passes `closeTemporalClient` as callback to watch mode; doesn't fit the helper pattern cleanly

### Commit 3: `refactor(workflow): extract polling workflow handler factory`

Finding 2. Creates factory, rewrites both 56-line handler files to ~15-line declarations.

#### `src/commands/workflow/start-command/polling-workflow.ts` — new file

Factory function `createPollingWorkflowHandler<TInput>(config)` → returns `StartWorkflowHandler`.

Config parameterizes the 9 unique values between the two handlers:
- `workflowKind` — for ID generation (`'engagement-tracking'` | `'topic-monitor'`)
- `workflowFunction` — the imported Temporal workflow function
- `requiredOptionKey` — `'tweetId'` | `'topic'`
- `requiredOptionError` — validation message
- `operation`, `profileName`, `capability` — capability plan strings
- `headerTitle` — e.g. `'Starting Engagement Tracking Workflow'`
- `primaryValueLabel` — e.g. `'Tweet ID'` | `'Topic'`
- `primaryInputKey` — e.g. `'tweetId'` | `'topic'`
- `buildInput(primaryValue, intervalMinutes?, maxCycles?)` → `TInput`

The factory body contains the shared logic: validate required option, generate workflow ID, build input, build capability plan, print header/details, start workflow, print success.

#### `src/commands/workflow/start-command/engagement-tracking.ts` — rewrite

Replace 56-line function with `createPollingWorkflowHandler<EngagementTrackingWorkflowInput>({...})` declaration (~15 lines).

#### `src/commands/workflow/start-command/topic-monitor.ts` — rewrite

Same pattern with topic-monitor config values.

#### `src/commands/workflow/start-command/handlers.ts` — no change

Imports are named the same (`startEngagementTrackingWorkflow`, `startTopicMonitorWorkflow`). Export style changes from `export async function` to `export const` but named imports work identically.

### Verification

1. `pnpm typecheck` — confirms factory return types match `StartWorkflowHandler`
2. `pnpm lint` — import ordering, no unused imports
3. `pnpm test` — all 242 existing tests pass
4. `pnpm dev sync -h` — subcommands unchanged
5. `pnpm dev workflow start -h` — workflow types unchanged

## Feedback

## Action Items

## Notes

## Review Findings (2026-02-19)

1. **Medium** — `src/temporal/client.ts` now mixes infrastructure and CLI concerns by embedding `notify(...)` + `process.exit(1)` in `withTemporalClient` (`src/temporal/client.ts:7`, `src/temporal/client.ts:76`). This makes the client-layer helper harder to reuse outside CLI command handlers and harder to unit test in isolation. Prefer keeping `src/temporal/client.ts` focused on client lifecycle and throwing typed errors, with CLI exit/notification policy handled in command-layer wrappers.
2. **Low** — `sync` command output now announces workflow startup before Temporal availability is validated in two paths (`src/commands/sync/bookmarks/temporal.ts:50`, `src/commands/sync/media-download.ts:36`, while availability is checked inside `withTemporalClient` at `src/commands/sync/bookmarks/temporal.ts:71` and `src/commands/sync/media-download.ts:39`). When Temporal is down, this can show “Starting ... Workflow” followed by an availability failure, which is a UX regression from earlier fail-fast behavior.
3. **Low** — Coverage for new abstractions is thin: there are no direct tests for `withTemporalClient` failure paths or `createPollingWorkflowHandler` validation/start behavior. Current routing tests mock `withTemporalClient` itself (`tests/sync-command-routing.test.ts:40`), so helper semantics are not exercised. Add targeted unit tests to lock down availability, error-label propagation, cleanup, and required-option enforcement.
