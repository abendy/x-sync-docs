# Plan: Require folder arg in workflow start sync (matching CLI)

**Status:** Complete
**Created:** 2026-03-04
**Source:** ~/.claude/plans/swift-inventing-ocean.md

## Context

The CLI command `sync bookmarks` requires a folder argument (unless `--no-folders` is passed), but `workflow start sync` silently accepts no `--folder` and passes `undefined` downstream. This asymmetry should be fixed so both entry points enforce the same rule: **folder is required unless `--no-folders` is explicitly set**.

## Changes

### 1. Add folder-required guard to `src/commands/workflow/start-command/sync.ts`

Insert a check at the top of `startSyncWorkflow`, before the folder-resolution block (before line 27), matching the CLI logic from `options.ts:8-16`:

```typescript
if (!options.folder && options.folders !== false) {
  console.log(kleur.red('Error: --folder is required'));
  console.log(kleur.red('  Use "folder list" to see available folders'));
  console.log(kleur.red('  Or use --no-folders to sync all bookmarks'));
  process.exit(1);
}
```

No other files need changes — the CLI path already has this guard in `src/commands/sync/bookmarks/options.ts:8-16`, and `--no-folders` stays as a dev escape hatch in both paths.

### 2. Add test coverage in `tests/sync-command-routing.test.ts`

Add a test case verifying that `workflow start sync` (without `--folder` and without `--no-folders`) errors out.

## Files to modify

- `src/commands/workflow/start-command/sync.ts` — add guard
- `tests/sync-command-routing.test.ts` — add test

## Verification

- `pnpm test` — existing tests pass, new test passes
- Manual: `pnpm dev workflow start sync` → should error with folder-required message
- Manual: `pnpm dev workflow start sync --folder MyFolder` → should work as before

## Notes
