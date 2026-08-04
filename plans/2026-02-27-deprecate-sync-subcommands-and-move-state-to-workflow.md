# Plan: Deprecate `sync` subcommands and move `state` to `workflow`

**Status:** Deferred
**Created:** 2026-02-27
**Source:** ~/.claude/plans/enchanted-singing-music.md

## Context

The CLI has two entry points that trigger the same Temporal workflows:

- `sync bookmarks` / `workflow start sync`
- `sync media-download` / `workflow start media-download`

The `sync` command is being deprecated in favor of `workflow`. This change deprecates the duplicate subcommands, moves `sync state` to `workflow state`, and keeps `sync folders` as the only non-deprecated subcommand.

## Changes

### 1. Create shared deprecation constants

**New file:** `src/commands/sync/deprecation.ts`

Centralize deprecation date (`2026-02-27`), removal target (`2026-04-27`), and warning messages for `bookmarks`, `enrich`, `media-download`, and `state`. Follow the existing pattern from `bookmarks/register.ts` lines 12-17.

### 2. Create `workflow state` command

**New file:** `src/commands/workflow/state.ts`

Copy the action handler from `src/commands/sync/state.ts` (lines 8-53) into a new `registerWorkflowStateCommand()` function. Same options (`--clear`, `--key`), same DB calls, same output.

### 3. Register `workflow state`

**Modify:** `src/commands/workflow/register.ts`

Add import and call `registerWorkflowStateCommand(workflow)` after the existing registrations (line 13).

### 4. Add deprecation warnings to sync subcommands

**Modify each file** — update `.description()` with `[DEPRECATED]` prefix and add `notify('warning', ...)` at the top of each `.action()` handler:

| File | Replacement command |
| --- | --- |
| `src/commands/sync/bookmarks/register.ts` (line 22 desc, line 36 action) | `workflow start sync` |
| `src/commands/sync/enrich.ts` (line 19 desc, line 23 action) | `workflow start enrich` |
| `src/commands/sync/media-download.ts` (line 18 desc, line 21 action) | `workflow start media-download` |
| `src/commands/sync/state.ts` (line 11 desc, line 14 action) | `workflow state` |

Import `notify` from `../../lib/notifications.js` where not already imported (enrich.ts already imports `sectionHeader` from there; media-download.ts and state.ts need the import).

### 5. Update `sync` top-level description

**Modify:** `src/commands/sync/register.ts` (line 9)

Change description to: `'Sync bookmarks and folders from X API (most subcommands deprecated; use "workflow" instead)'`

### 6. No changes to `sync folders`

`src/commands/sync/folders.ts` stays as-is with no deprecation warning.

## Verification

```bash
# Deprecated commands show warning then work
pnpm dev sync bookmarks -h        # [DEPRECATED] in description
pnpm dev sync enrich -h           # [DEPRECATED] in description
pnpm dev sync media-download -h   # [DEPRECATED] in description
pnpm dev sync state -h            # [DEPRECATED] in description

# Non-deprecated command works without warning
pnpm dev sync folders -h          # No deprecation

# New workflow state command works
pnpm dev workflow state -h        # Shows options
pnpm dev workflow -h              # Lists state subcommand

# Top-level sync help shows deprecation note
pnpm dev sync -h
```

## Notes
