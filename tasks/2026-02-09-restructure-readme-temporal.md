# Restructure README: integrate Temporal workflow commands with their features

**Status:** Complete

## Context

Temporal is the default execution path, yet it's documented in a separate section at the bottom of the README. This creates duplication (sync/enrich described twice) and buries the primary commands. The user wants to integrate workflow commands into each feature's docs so readers see the Temporal command first, then the `--local` alternative.

## Current structure

```text
## Commands
  ### Sync
    #### sync bookmarks  ← options table, no workflow examples
    #### sync enrich     ← local only, mentions workflow alternative in prose
    #### sync folders
    #### sync state
  ### Folder Management
  ### Browse & Status
  ### Auth
## Temporal Workflows   ← separate section, duplicates sync/enrich examples
  ### Setup             ← prerequisite infra
  ### Workflow Commands  ← big mixed code block
## Documentation
## Development
```

## Proposed structure

```text
## Commands
  ### Temporal Setup        ← moved up as prerequisite, trimmed
  ### Sync Bookmarks        ← Temporal first, --local noted, options table
  ### Enrichment            ← workflow start enrich first, local alternative
  ### Workflow Management    ← status/pause/resume/cancel/list (extracted)
  ### Sync Utilities         ← sync folders, sync state (grouped)
  ### Folder Management
  ### Browse & Status
  ### Auth
## Documentation
## Development
```

## Changes — `README.md`

### 1. Move Temporal Setup into Commands as first subsection

Take the existing Setup block (lines 184-196) and place it as `### Temporal Setup` right after the `## Commands` heading (line 85). Trim the intro sentence — just say Temporal is required for default execution, then show the install/start commands. Mention `--local` bypasses Temporal for quick ad hoc runs.

### 2. Rewrite sync bookmarks section (lines 91-116)

Keep the heading and usage line. Show usage examples inline:

```bash
# Sync a folder (default = Temporal workflow)
pnpm dev sync <folder-id>

# Sync a folder locally (no Temporal needed)
pnpm dev sync --local <folder-id>

# Dry run (implies --local)
pnpm dev sync --dry-run <folder-id>

# Resume from saved pagination token
pnpm dev sync --resume <folder-id>
```

Keep the options table (already reordered from previous commit). Keep the notes about `--limit` and folder endpoint limitation.

### 3. Rewrite enrichment section (lines 118-131)

Rename to `#### Enrichment` (drop `sync` prefix). Show workflow command as primary, then local alternative:

```bash
# Enrich stub records (Temporal workflow)
pnpm dev workflow start enrich --limit 100

# Re-enrich outdated records
pnpm dev workflow start enrich --outdated --limit 100

# Retry previously unavailable tweets
pnpm dev workflow start enrich --retry-unavailable

# Local enrichment (no Temporal needed)
pnpm dev sync enrich --outdated --limit 50
```

Keep the local-only options table for `sync enrich`.

### 4. Add Workflow Management subsection

Extract status/pause/resume/cancel/list from the old Temporal section into `### Workflow Management` under Commands:

```bash
pnpm dev workflow status <workflow-id>
pnpm dev workflow status <workflow-id> --watch
pnpm dev workflow pause <workflow-id>
pnpm dev workflow resume <workflow-id>
pnpm dev workflow cancel <workflow-id>
pnpm dev workflow list
pnpm dev workflow list --status running
```

Include the Temporal Web UI note here.

### 5. Group sync folders + sync state as Sync Utilities

Rename to `### Sync Utilities` and keep sync folders and sync state together. These are non-workflow utility commands.

### 6. Remove the standalone Temporal Workflows section

Its content is now distributed: setup → top of Commands, sync examples → sync bookmarks, enrich examples → enrichment, management commands → workflow management. Delete lines 180-232.

### 7. Update cross-references

- The ADR link (`See ADR 011...`) moves to the Temporal Setup subsection.
- Line 114 still references `--no-folders` in the folder endpoint note — update to mention enrichment instead.

## File modified

`README.md`

## Verification

1. Review structure visually — headings should read as a coherent hierarchy
2. No broken markdown links
3. All commands from the old Temporal section are present in the new structure
4. `pnpm lint` — passes (no code changes)
