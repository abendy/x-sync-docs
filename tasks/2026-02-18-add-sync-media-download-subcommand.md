# Plan: Add `sync media-download` subcommand

## Context

The `sync` command has subcommands for bookmarks, enrich, folders, and state — but no `media-download`. The `workflow start media-download` path exists, but there's no `sync media-download` entry point mirroring how `sync bookmarks` starts a Temporal sync workflow. This adds that entry point so users can run `pnpm dev sync media-download` to start a Temporal media-download workflow.

## Approach

Follow the `sync bookmarks` → `temporal.ts` pattern exactly: check Temporal availability, build input, start workflow, print monitoring instructions. Single file, no local fallback.

## Files to create

### `src/commands/sync/media-download.ts`

New file modeled on `src/commands/sync/bookmarks/temporal.ts`:

- `registerSyncMediaDownloadCommand(sync)` — registers `sync.command('media-download')` with options:
  - `-l, --limit <count>` — limit number of media files
  - `--batch-size <size>` — batch size (default 20)
- Action handler:
  1. `isTemporalAvailable()` check → exit if not
  2. `loadConfig()` to get `mediaDir`
  3. Generate workflow ID via `generateWorkflowId('media-download')` from `../workflow/shared.js`
  4. Build `MediaDownloadWorkflowInput` from options + config
  5. `buildSingleCapabilityPlanOrExit()` with capability `'download-media'`
  6. Print header (reuse `printWorkflowStartHeader` / `printWorkflowStarted` from `../workflow/start-command/output.js`)
  7. `client.workflow.start(mediaDownloadWorkflow, ...)`
  8. `closeTemporalClient()` in finally

## Files to modify

### `src/commands/sync/register.ts`

- Import `registerSyncMediaDownloadCommand` from `./media-download.js`
- Add `registerSyncMediaDownloadCommand(sync)` call

## Verification

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `pnpm dev sync -h` — confirm `media-download` appears in subcommand list

## Code Review Findings (2026-02-19)

### High

1. ~~**`sync media-download` does not validate numeric CLI inputs before starting the workflow**~~
   - Evidence: `src/commands/sync/media-download.ts:34`-`src/commands/sync/media-download.ts:35` parse `--limit` / `--batch-size` with `Number.parseInt`, but there is no `Number.isFinite`/positive guard.
   - Downstream impact: invalid values can propagate into workflow math (`src/temporal/workflows/media-download/pass.ts:33`-`src/temporal/workflows/media-download/pass.ts:35`), producing invalid query limits and undefined runtime behavior.
   - Recommendation: enforce strict positive integer validation in command parsing (same pattern as `sync enrich` input guards in `src/commands/sync/enrich.ts:41`-`src/commands/sync/enrich.ts:48`).
   - **Resolution:** Added `Number.isFinite`/positive guards for both `--limit` and `--batch-size` in `src/commands/sync/media-download.ts:37-44`.

### Medium

1. ~~**Implementation duplicates existing media-download workflow start logic instead of sharing abstraction**~~
   - Evidence: `src/commands/sync/media-download.ts:30`-`src/commands/sync/media-download.ts:73` substantially duplicates `src/commands/workflow/start-command/media-download.ts:12`-`src/commands/workflow/start-command/media-download.ts:48` (input construction, capability-plan build, start call, output formatting).
   - Architectural risk: duplicate startup logic creates drift risk (future option validation, telemetry/capability config, and output behavior can diverge across two entry points).
   - Recommendation: extract shared media-download start/input planning helper and reuse from both command surfaces.
   - **Resolution:** Extracted `prepareMediaDownloadWorkflow()` and `printMediaDownloadDetails()` into `src/commands/shared/media-download.ts`. Both `sync/media-download.ts` and `workflow/start-command/media-download.ts` now use the shared helper.

2. ~~**No automated tests were added for the new `sync media-download` route**~~
   - Evidence: `tests/sync-command-routing.test.ts` currently covers only default/explicit `sync bookmarks` flows (`tests/sync-command-routing.test.ts:56`, `tests/sync-command-routing.test.ts:82`), with no `sync media-download` coverage.
   - Risk: registration and option-to-workflow wiring regressions for the new subcommand can ship unnoticed.
   - Recommendation: add routing tests asserting subcommand registration, workflow function started (`mediaDownloadWorkflow`), and args mapping (`limit`, `batchSize`, `mediaDir`).
   - **Resolution:** Added 2 routing tests in `tests/sync-command-routing.test.ts`: default options (verifies registration, workflow function, default args, workflow ID prefix) and `--limit`/`--batch-size` (verifies parsed numeric options flow through).

### Low

1. ~~**README does not document the new subcommand entry point**~~
   - Evidence: media download docs list only `workflow start media-download` examples (`README.md:199`-`README.md:203`), not `pnpm dev sync media-download`.
   - Recommendation: add one short usage example for `sync media-download` to keep both supported entry points discoverable.
   - **Resolution:** Updated `README.md` media download section to show `sync media-download` as the primary entry point alongside `workflow start media-download`.
