# Plan: Add folder name resolution to sync commands

**Status:** Complete
**Created:** 2026-03-04
**Source:** ~/.claude/plans/curious-giggling-dongarra.md

## Context

Currently `sync` and `workflow start sync` require a raw folder ID (e.g. `1234567890`). The user wants to pass a human-readable folder **name** instead (e.g. `Home`), with the CLI resolving it to the folder ID via the local database.

## Approach

### 1. Add `getFolderByName()` to `FolderRepo`

**File:** `src/lib/db/folder-repo.ts`

- Add method: `getFolderByName(name: string): DbFolder | undefined`
- Case-insensitive match using SQLite `COLLATE NOCASE` or `LOWER()`

### 2. Add shared folder-name resolver utility

**New file:** `src/lib/resolve-folder.ts`

- Export `resolveFolderArg(db, arg: string): { folderId: string } | { error: string }`
- Logic: try `db.getFolder(arg)` first (exact ID match). If not found, try `db.getFolderByName(arg)`. If neither found, return error with hint to run `folder list`.
- This keeps resolution logic in one place for both entry points.

### 3. Wire into `sync bookmarks` command

**File:** `src/commands/sync/bookmarks/register.ts`

- Before calling `resolveSyncBookmarksOptions`, resolve the folder arg via `resolveFolderArg()`
- Pass the resolved folder ID downstream (rest of the pipeline stays the same)
- Update argument description: `'Folder name or ID to sync'`

### 4. Wire into `workflow start sync` command

**File:** `src/commands/workflow/start-command/sync.ts`

- Resolve `options.folder` via `resolveFolderArg()` before building `SyncWorkflowInput`
- Print resolved folder name in the header output for clarity

**File:** `src/commands/workflow/start-command/register.ts`

- Update option description: `'Folder name or ID to sync (sync only)'`

### 5. Expose `getFolderByName` on `BookmarksDb` facade

**File:** `src/lib/db/client.ts`

- Add `getFolderByName(name)` delegate method (same pattern as `getFolder`)

## Files to modify

1. `src/lib/db/folder-repo.ts` — add `getFolderByName()`
2. `src/lib/db/client.ts` — expose `getFolderByName()` on facade
3. `src/lib/resolve-folder.ts` — new shared resolver (~20 lines)
4. `src/commands/sync/bookmarks/register.ts` — resolve before options parsing
5. `src/commands/workflow/start-command/sync.ts` — resolve before workflow input
6. `src/commands/workflow/start-command/register.ts` — update help text

## Verification

- `pnpm dev sync Home` → resolves "Home" to folder ID, starts sync
- `pnpm dev sync <actual-id>` → still works (ID takes priority)
- `pnpm dev sync Nonexistent` → clear error with hint
- `pnpm dev workflow start sync --folder Home` → resolves and starts
- `pnpm dev sync --no-folders` → unchanged behavior

## Notes
