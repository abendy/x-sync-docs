# Plan: Deprecate sync enrich (local-only enrichment)

**Status:** Approved
**Created:** 2026-03-05
**Source:** ~/.claude/plans/linear-waddling-bunny.md

## Context

The `sync enrich` command (`src/commands/sync/enrich.ts`) was the original way to enrich stub records before the Temporal EnrichWorkflow existed. It runs enrichment locally without Temporal, calling the `enrichRecord` activity directly in a simple loop with rate-limit retry.

Every option `sync enrich` supports is now a subset of what `workflow start enrich` already handles:

| `sync enrich` option | `workflow start enrich` equivalent |
| --- | --- |
| `--limit` | `--limit` |
| `--batch-size` | `--batch-size` |
| `--outdated` | `--outdated` |

The workflow additionally supports: `--retry-unavailable`, `--policy`, `--tweet-id`, `--file`, policy lanes, API-call budgets, cross-run retry with backoff, pause/resume/cancel signals, and progress queries.

**Verdict:** There is no capability gap. The local command is strictly inferior and adds maintenance surface. It should be removed.

## Changes

### 1. Delete `src/commands/sync/enrich.ts`

Remove the entire file (150 lines).

### 2. Update `src/commands/sync/register.ts`

- Remove the import of `registerSyncEnrichCommand`
- Remove the `registerSyncEnrichCommand(sync)` call (line 12)

### 3. Update `src/commands/sync/bookmarks/local/summary.ts`

Line 75 prints `pnpm dev sync enrich` as a hint after local sync. Replace with the workflow equivalent:

```text
pnpm dev workflow start enrich
```

### 4. Update `README.md`

- Remove the "Local-only options for `sync enrich`" table (lines 201-207)
- Remove the two local enrichment example commands (lines 194-198)
- Replace with a brief note that all enrichment runs via Temporal workflows

### 5. Update ADR references (docs only)

- `docs/adr/021-decoupled-enrichment.md` — update mentions of `sync enrich` to `workflow start enrich`
- `docs/adr/020-fields-version-tracking.md` — update reference to `sync enrich --outdated`

### 6. Update CHANGELOG.md

Add a `Removed` entry under the next release noting the deprecation of `sync enrich` in favor of `workflow start enrich`.

## Files to modify

| File | Action |
| --- | --- |
| `src/commands/sync/enrich.ts` | Delete |
| `src/commands/sync/register.ts` | Remove import + call |
| `src/commands/sync/bookmarks/local/summary.ts` | Update hint text |
| `README.md` | Remove local-only section, update examples |
| `docs/adr/021-decoupled-enrichment.md` | Update references |
| `docs/adr/020-fields-version-tracking.md` | Update reference |
| `CHANGELOG.md` | Add removed entry |

## Verification

1. `pnpm build` — confirms no broken imports
2. `pnpm typecheck` — no type errors from removed module
3. `pnpm test` — all tests pass (no tests for `sync enrich` exist)
4. `pnpm lint` — clean
5. Manual: `pnpm dev sync --help` — confirm `enrich` subcommand no longer appears
6. Manual: `pnpm dev workflow start enrich --help` — confirm all options still work

## Notes
