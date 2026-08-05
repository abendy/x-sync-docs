# Import X Links — paste-driven, one-shot

Date: 2026-08-04
Repository: x-bookmarks-scraper
Status: In Review — implemented and merged (PR #11 squash `cb4a3fa`, delete-queue guard follow-up `f7034b4`, ADR 034); owner acceptance checklist below still open. D5 tracked separately; typed ResolveResult discriminant remains a follow-up.

> Scope note: the owner suspended the 2026-04-27 feature pause for this feature. One-shot: build it, use it, move on.

## Summary

A single CLI command that ingests a pasted list of X post links (one per line), creates stub tweets + bookmark rows in a target folder, and lets the existing enrichment pipeline do the rest. No browser connectors, no Notes integration, no general-link store — X posts only.

## Command

```
pnpm dev import --folder <name-or-id> [file]
pnpm dev import --folder <name-or-id> --dry-run [file]
```

- `[file]` is a path to a text file; omitted → read stdin (paste, then Ctrl-D). One link per line; blank lines and `#` comments skipped.
- `--folder` is required. Resolution:
  1. `resolveFolderArg(db, arg)` (src/lib/resolve-folder.ts:5) against existing local folders — same UX as `sync <folder>`. Imports land **directly in the real folder under its X id**; no parallel/local id scheme.
  2. No match → treat the argument as a **new folder name**: create it via `upsertFolder(name, name)` (src/lib/db/folder-repo.ts:21) — the established placeholder convention (`ensureFolderExists` already inserts id==name rows; ADR-noted "folder name may equal id"). If a folder with that name later appears on X with a numeric id it will be a distinct row; acceptable for one-shot.
  3. Ambiguous name → list candidates and exit non-zero (mirror existing resolve behavior).
- `--dry-run` parses and classifies, prints the report, writes nothing.

## Parsing rules

Accept per line, extracting `<id>`:

- `https://x.com/<user>/status/<id>` and `twitter.com` equivalent (query strings and trailing `/photo/1`-style segments stripped)
- `https://x.com/i/status/<id>` / `/i/web/status/<id>`
- Bare numeric status id (15–20 digits)

Rejected with a per-line reason in the report: `t.co` short links (no network resolution in this feature), non-X URLs, anything unparseable. Duplicate ids within the input are collapsed.

## Write path (all existing code)

Per parsed id, inside one transaction:

1. `upsertPartialTweet({ id, ... })` — tweet-write-repo.ts:129. COALESCE semantics preserve any existing data; already-synced tweets no-op.
2. `upsertBookmark(id, folderId, origin)` — bookmark-write-repo.ts:16, extended with an origin parameter (see below); returns whether a row was created → drives the new-vs-already-in-folder counts.

Nothing else: no delete_queue entries, no sync_state, no workflow starts by the import command itself.

### Provenance + drain exclusion (owner decision 2026-08-05)

Imported links are not necessarily real X bookmarks, and every delete attempt spends API quota (~50 deletes/15 min measured). Mechanism:

- `bookmarks` gains `origin TEXT NOT NULL DEFAULT 'sync'` — added to the CREATE TABLE in schema.ts for fresh DBs plus an idempotent runtime `ALTER TABLE` for existing DBs, following the established ensure-column pattern (src/lib/db/media-repo.ts `ensureLocalPathColumn` is the model).
- Import writes `origin = 'import'`.
- The backlog query (src/lib/db/bookmark-query-repo.ts:23) adds `AND origin != 'import'` — imported rows never reach the delete coordinator, so no quota is spent on links that may never have been bookmarks.
- When a folder sync **re-observes** the same `(tweet_id, folder_id)` from X — proof it IS a real bookmark — the `upsertBookmark` re-seen/update path sets `origin = 'sync'`, and the row joins the normal archive-then-drain lifecycle from then on. No other code path needs to know origins exist.

Enrichment: manual enrich is target-based (ADR 029). The report ends by suggesting a runnable `pnpm dev workflow start enrich --tweet-id <id> ...` command listing the actual enrichment candidates (fixed in `cd2710e` — the originally spec'd `--limit N` form was rejected by the CLI).

## Report (stdout)

```
Imported into "IDE" (1791238115379564827)
  12 new bookmarks (12 new stubs)
   3 already in folder
   2 already archived from other folders (added here too)
   1 line skipped: t.co link (resolve manually)
Enrich: pnpm dev workflow start enrich --tweet-id 2006481858289361339 --tweet-id 2006519723887046845 ...
```

## Out of scope (explicit)

Browser/Notes connectors, non-X links, a general links store, t.co resolution, envelope/dada.stream lift, any UI. If a future need appears, it starts as a new plan.

## D5 — two-machine database (MBP + Mini), tracked separately

The import feature writes to whatever `data/bookmarks.db` it runs against; it neither depends on nor changes this decision.

- **Recommended: single-home the DB on the Mini.** The dada.stream runtime substrate (ADR-012) already designates the Mini as the always-on primary running services over Tailscale. Worker + Temporal + `bookmarks.db` live there; the MBP runs commands via SSH (`ssh mini 'cd ~/projects/x-bookmarks-scraper && pnpm dev import ...'` — or paste-import from the MBP by piping stdin through ssh). Zero code changes, single-writer discipline preserved.
- **Decided 2026-08-05 — Litestream to rsync.net:** continuous replication from the Mini over SFTP, MBP restores copies on demand. Own plan: `.project/plans/2026-08-05-litestream-rsync-net.md`.
- **Rejected for now: cloud DB (Turso/libSQL).** True multi-machine writes, but the entire repo layer is synchronous better-sqlite3 (package.json ^12.9.0); libSQL's client is async — a full db-layer refactor. That decision belongs to the dada.stream migration, not a one-shot feature.
- **Do not** put `bookmarks.db` in iCloud Drive/Syncthing: file-level sync of a live WAL database is a corruption generator, and two writers would silently clobber.

## Handoff prompt (paste to worker agent)

```markdown
Work in /Users/abendy/projects/x-bookmarks-scraper (branch: develop, use a worktree).
First read: CLAUDE.md, .claude/ts-style.md, .claude/ts-testing.md, .claude/ts-packages.md.

Do not remove, inline, or reshape existing code to dodge lint limits. Do not make unrelated changes.

## Task

Add a `pnpm dev import` CLI command: paste-driven import of X post links into the local
bookmarks database as stub tweets + bookmark rows in a chosen folder.

Spec (authoritative): .project/plans/2026-08-04-import-x-links.md — sections Command,
Parsing rules, Write path, Report. Follow it exactly; Out of scope means out of scope.

## Grounding (already verified)

- Folder resolution: resolveFolderArg(db, arg) — src/lib/resolve-folder.ts:5. Imports land in the
  real folder under its X id — no parallel id scheme.
- New named folders: upsertFolder(name, name) — src/lib/db/folder-repo.ts:21 (id==name placeholder,
  same convention as ensureFolderExists at folder-repo.ts:11)
- Stub write: upsertPartialTweet(...) — src/lib/db/tweet-write-repo.ts:129 (COALESCE-preserving)
- Bookmark write: upsertBookmark(tweetId, folderId): boolean — src/lib/db/bookmark-write-repo.ts:16.
  Extend with origin ('sync' default | 'import'); the re-seen/update path must set origin='sync'.
- New column: bookmarks.origin TEXT NOT NULL DEFAULT 'sync' — schema.ts CREATE TABLE + idempotent
  runtime ALTER for existing DBs (model: src/lib/db/media-repo.ts ensureLocalPathColumn).
- Backlog exclusion: add AND origin != 'import' to the backlog query —
  src/lib/db/bookmark-query-repo.ts:23. No other query changes.
- Command wiring: src/cli/program.ts (createProgram) — register `import` alongside existing commands;
  follow the structure of an existing simple command (e.g. folder or browse) for layout under src/commands/.

## Hard constraints

- No workflow-code changes (src/temporal/** untouched). Do not start/stop Temporal, the worker,
  or any workflow — live singletons may be running.
- No new dependencies.
- No writes outside: src/commands/** (new import command), src/cli/program.ts (registration),
  src/lib/db/schema.ts + src/lib/db/bookmark-write-repo.ts + src/lib/db/bookmark-query-repo.ts
  (origin column, exactly as specified in the plan — nothing else in the db layer),
  src/types/** (only if a type is genuinely needed), tests/**.
- The command must never enqueue deletes or touch delete_queue/sync_state. Drain exclusion works
  ONLY via the origin column as specified — do not filter the delete coordinator or sync engine
  directly.

## Verification (no live infra required)

1. pnpm lint && pnpm typecheck && pnpm test
2. New tests/import-command.test.ts covering: URL forms (user/status, /i/status, bare id,
   query-string strip), t.co and non-X rejection with reasons, in-input dedupe, existing-folder
   resolution, new-folder creation (id==name placeholder), already-known tweet → bookmark row only,
   --dry-run writes nothing, report counts. Origin coverage: import rows get origin='import';
   sync-path rows default 'sync'; backlog query excludes 'import' rows; re-observed import flips
   to 'sync' and appears in backlog. Runtime migration: opening a pre-column DB adds the column
   idempotently. Use a temp SQLite db per test (see tests/db.test.ts for the established pattern).
3. Manual smoke against a THROWAWAY copy: cp data/bookmarks.db /tmp/import-smoke.db and run
   the command with a 3-line paste against it (never the real data/bookmarks.db).

## Commit

Stage files by name. Subject-only conventional message: feat(import): add paste-driven X link import command
No body, no trailers, no attribution lines. Do NOT push.

## Report back

Reply with: the commit SHA, files touched, test count added, and any spec deviation you had
to make (with one-line justification). If the spec blocked you, stop and report instead of improvising.
```

## Follow-up: `--import-stubs` enrich discovery mode (handoff written 2026-08-05)

Dozens of imports make the `--tweet-id` suggestion unwieldy. New discovery mode: `workflow start enrich --import-stubs` enriches every stub with an import-origin bookmark; the import report suggests `--tweet-id` flags for ≤5 candidates, else the short mode. Handoff prompt:

```markdown
Work in the x-bookmarks-scraper repo (github.com:abendy/x-bookmarks-scraper). Rebase your work
onto latest develop before finalizing — linear history, no merge commits. Create a topic branch,
run pnpm install. First read: CLAUDE.md, .claude/ts-style.md, .claude/ts-testing.md.

Do not remove, inline, or reshape existing code to dodge lint limits. Do not make unrelated changes.

## Environment facts

Never run `pnpm dev auth`, live syncs, or Temporal servers/workers. All verification is offline:
vitest with temp DBs (tests/db.test.ts pattern). Do not touch data/bookmarks.db.

## Task — `--import-stubs` discovery mode for manual enrich

Context: `pnpm dev import` lands stub bookmarks with `origin='import'` (ADR 034). Manual enrich
is targets-or-maintenance only (ADR 029): `--tweet-id`/`--file`, or `--retry-unavailable`/
`--outdated`. After large imports the suggested --tweet-id list is unwieldy. Add a third
maintenance-style mode that discovers import stubs itself.

1. CLI (src/commands/workflow/start-command/enrich.ts): add `--import-stubs`, mirroring
   `--retry-unavailable`'s registration, validation, and display end to end. Exclusivity rules
   (see the existing checks around enrich.ts:107-150): mutually exclusive with `--tweet-id`/
   `--file` AND with `--retry-unavailable`/`--outdated`; composes with `--limit` and policy
   flags exactly as --retry-unavailable does.
2. Workflow input (src/temporal/shared/enrich-types.ts:70 area): `importStubs?: boolean`,
   plumbed through src/temporal/workflows/enrich.ts the same way retryUnavailable is. Enrich
   workflows are per-run (not singletons), so input additions are replay-safe; still: NO changes
   to any other workflow file (orchestrator, delete-coordinator, sync).
3. Discovery (src/temporal/activities/query.ts:58 getStubRecords + its repo query in
   src/lib/db/tweet-query-repo.ts:54-66): when importStubs is set, select stubs
   (`full_json IS NULL`, same unavailable_at/next_retry_at candidate conditions as the standard
   stub selection) that have AT LEAST ONE bookmark row with `origin = 'import'` (EXISTS
   subquery; DISTINCT tweets), honoring the existing limit. Add the query as a sibling/variant,
   not by widening the default scan.
4. Import report (src/commands/import.ts, formatImportReport + enrichmentCandidateIds): when
   candidates ≤ 5 keep the current --tweet-id suggestion; when > 5 suggest exactly
   `pnpm dev workflow start enrich --import-stubs`. Update tests, adding a >5-candidates case.
5. README: extend the workflow-enrich notes with the new mode, one or two lines, matching the
   existing style.

## Hard constraints

- Allowed writes: src/commands/workflow/start-command/enrich.ts, src/commands/import.ts,
  src/temporal/shared/enrich-types.ts, src/temporal/workflows/enrich.ts (input plumbing only),
  src/temporal/activities/query.ts, src/lib/db/tweet-query-repo.ts (+ the BookmarksDb facade in
  src/lib/db/client.ts only if a new repo method must surface), src/types/**, tests/**, README.md.
- No new dependencies. Semantics: --import-stubs must never enrich sync-origin stubs that lack an
  import bookmark, and must skip unavailable/in-retry tweets like every other mode.

## Verification (offline)

1. pnpm lint && pnpm typecheck && pnpm test
2. New tests: CLI exclusivity (--import-stubs + --tweet-id rejected; + --retry-unavailable
   rejected); discovery selects import-origin stubs only (sync-origin stub excluded, already-
   enriched import excluded, unavailable_at/next_retry_at excluded, limit respected,
   multi-folder import counted once); workflow input plumbing (mirror the retryUnavailable cases
   in tests/temporal-enrich-workflow.test.ts); import report threshold (5 → --tweet-id form,
   6 → --import-stubs form).

## Commit / PR

Stage files by name. Conventional subject:
feat(enrich): add --import-stubs discovery mode
Optional 2-4 line body on the why. No trailers. Rebase onto latest develop, push the topic
branch, open a PR against develop. No merge commits.

## Report back

PR number, files touched, test count added, and any spec deviation with one-line justification.
If blocked, stop and report instead of improvising.
```

## Acceptance (owner checklist)

- [ ] `pnpm dev import --folder IDE --dry-run links.txt` classifies correctly
- [ ] Real run lands bookmarks in the chosen X folder (or creates the named placeholder folder); stubs appear via `pnpm dev status` / browse
- [ ] Imported rows carry `origin='import'` and do NOT appear in the next drain sync's backlog; a sync-re-observed one flips to `'sync'`
- [ ] `workflow start enrich` fills them; they show up in the next digest
