# Limitation Canary System

**Status**: Complete (2026-02-13)

## Context

The X API has several known broken behaviors (folder endpoint returns only IDs, no pagination support, delete is global). These are documented in `docs/issues/` and re-verified manually via scripts in `.project/scripts/`. Currently there is no automated way to detect during a normal sync or enrich run that a limitation may have been fixed. This means we could continue applying workarounds (stub enrichment, delete-to-reveal cycling) long after the API is updated.

The goal is a lightweight runtime detection system that inspects data already flowing through the pipeline — no extra API calls — and alerts through multiple channels when it sees evidence that a known limitation may be resolved.

## Design

### New file: `src/lib/limitation-canary.ts`

Self-contained module with three concerns:

**1. Registry** — A `readonly` array of `KnownLimitation` entries, each with:

- `id` matching the `docs/issues/` filename (e.g. `'folder-pagination'`)
- `description`, `issueDoc` path
- `sites` — which detection points it applies to (`'folder-bookmarks-response'` | `'folder-list-response'`)
- `detect(context)` — pure, synchronous function returning `{ possiblyFixed: boolean, evidence: string }`

**2. Detector** — `LimitationCanary` class:

- Accepts an array of `CanaryAlertChannel` implementations
- `check(context)` iterates matching limitations, calls `detect()`, dispatches alerts
- Deduplicates via `Set<string>` — each limitation fires at most once per instance
- `getAlertedIds()` exposes what was triggered (for workflow results/testing)

**3. Alert channels** — `CanaryAlertChannel` interface with four built-in factories:

- `createLoggerChannel()` → `logger.warn('CANARY', ...)` (structured JSON log)
- `createNotifyChannel()` → `notify('warning', ...)` (CLI console output)
- `createWebhookChannel(url)` → fire-and-forget `fetch()` POST with 5s timeout
- `createCallbackChannel(onWarning)` → routes to `SyncCallbacks.onWarning`

Convenience factory `createLimitationCanary(options?)` wires up channels based on config.

### Registered limitations (initial)

| ID | Site(s) | Detection signal |
| --- | --- | --- |
| `folder-endpoint-limitation` | `folder-bookmarks-response` | `hasFullData && dataCompleteness === 'full'` |
| `folder-pagination` | `folder-bookmarks-response`, `folder-list-response` | `nextToken` present OR `resultCount > 20` / `folders.length > 20` |

`multi-folder-bookmarks` is excluded — detecting it requires extra API calls (bookmark in two folders, delete, check the other), which violates the passive-inspection constraint.

### Config extension

- Add `canaryWebhookUrl?: string` to `Config` interface in `src/types/index.ts`
- Load `CANARY_WEBHOOK_URL` env var in `src/lib/config.ts`

### DataSource.fetchFolders return type change

Currently `fetchFolders()` returns `{ id: string; name: string }[]`, discarding `nextToken` from the underlying API response. Change to:

```typescript
// src/sources/types.ts - DataSource interface
fetchFolders?(): Promise<{ folders: { id: string; name: string }[]; nextToken?: string }>;
```

Update `x-api.ts` to pass through `nextToken` from `client.getFolders()`. Update callers in `sync.ts` and `temporal/activities/fetch.ts`.

## Integration points

### 1. CLI sync adapter (`src/commands/sync-adapter.ts`)

Add optional `LimitationCanary` as constructor param. In `fetchBookmarks()`, after receiving the result, call `canary.check()` when `folderId` is present:

```typescript
if (options.folderId && this.canary) {
  this.canary.check({
    site: 'folder-bookmarks-response',
    folderBookmarksResponse: {
      tweets: result.tweets,
      nextToken: result.nextToken,
      resultCount: result.resultCount,
      dataCompleteness: result.dataCompleteness,
      hasFullData: result.dataCompleteness === 'full',
      folderId: options.folderId,
    },
  });
}
```

### 2. CLI sync command (`src/commands/sync.ts`)

- Instantiate canary via `createLimitationCanary({ webhookUrl: config.canaryWebhookUrl })`
- Pass to `new CliSyncOperations(..., canary)`
- After `dataSource.fetchFolders()` call (~line 568), check `folder-list-response`

### 3. Temporal sync workflow (`src/temporal/workflows/sync.ts`)

Create canary with only the callback channel (no I/O — safe for deterministic workflow code):

```typescript
const canary = new LimitationCanary({
  channels: [createCallbackChannel((msg) => callbacks.onWarning?.(msg))],
});
```

In `ops.fetchBookmarks()` (~line 207), after receiving `result`, call `canary.check()` the same way as the CLI adapter. The `onWarning` callback feeds into the workflow's `lastError`/error tracking, which surfaces via `workflow status --watch`.

Detection logic is pure (no I/O, no `Date.now()`, no randomness), so it's safe in Temporal workflow code.

## Files changed

| File | Change |
| --- | --- |
| `src/lib/limitation-canary.ts` | **NEW** — registry, detector, channels |
| `src/types/index.ts` | Add `canaryWebhookUrl?: string` to `Config` |
| `src/lib/config.ts` | Load `CANARY_WEBHOOK_URL` env var |
| `src/sources/types.ts` | Update `fetchFolders` return type to include `nextToken` |
| `src/sources/x-api.ts` | Surface `nextToken` from `fetchFolders()` |
| `src/commands/sync-adapter.ts` | Accept optional `LimitationCanary`, call `check()` in `fetchBookmarks()` |
| `src/commands/sync.ts` | Instantiate canary, pass to adapter; check folder-list response |
| `src/temporal/workflows/sync.ts` | Create canary with callback channel, check in `ops.fetchBookmarks` |
| `src/temporal/activities/fetch.ts` | Update `fetchFolders` activity to match new return type |
| `tests/limitation-canary.test.ts` | **NEW** — unit tests |

## Tests (`tests/limitation-canary.test.ts`)

Table-driven tests following existing Vitest patterns:

- **Detection functions**: For each limitation, test with "still broken" context (expect `possiblyFixed: false`) and "possibly fixed" context (expect `possiblyFixed: true`) with correct evidence strings
- **Deduplication**: Call `check()` twice with same triggering context, verify channel fires only once
- **Channel dispatch**: Mock `CanaryAlertChannel`, verify `alert()` called with correct args
- **Webhook channel**: Mock global `fetch`, verify POST payload and fire-and-forget error handling
- **`getAlertedIds()`**: Verify set tracks triggered limitations

## Verification

1. `pnpm typecheck` — no type errors from the new module or changed return types
2. `pnpm test` — existing tests pass, new `limitation-canary.test.ts` passes
3. `pnpm lint` — no lint issues
4. Manual: run `pnpm dev sync <folder-id> --local --no-delete` with a real folder — confirm no canary alerts fire (limitations still present), and structured log contains no CANARY entries
