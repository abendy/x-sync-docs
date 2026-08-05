# Import X Links — paste-driven, one-shot

Date: 2026-08-04
Repository: x-bookmarks-scraper
Status: Ready — supersedes the broader browser/notes draft (deleted); one environment decision (D5) tracked separately below, does not block the feature

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
  1. `resolveFolderArg(db, arg)` (src/lib/resolve-folder.ts:5) against existing local folders — same UX as `sync <folder>`.
  2. No match → treat the argument as a **new folder name**: create it via `upsertFolder(id, name)` (src/lib/db/folder-repo.ts:21) with generated id `local:<kebab-of-name>`. The `local:` prefix cannot collide with X's numeric folder ids.
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
2. `upsertBookmark(id, folderId)` — bookmark-write-repo.ts:16; returns whether a row was created → drives the new-vs-already-in-folder counts.

Nothing else: no delete_queue entries, no sync_state, no workflow starts. Imported rows have `deleted_from_x = 0` and no folder-sync exposure — `local:` folders have no X-side counterpart, so drain syncs can never target them (`sync local:...` fails folder resolution against X; acceptable for one-shot, no guard code required).

Enrichment: stubs are discovered by the standard `full_json IS NULL` scan. The report ends by suggesting `pnpm dev workflow start enrich --limit <n>` with the actual new-stub count.

## Report (stdout)

```
Imported into "Harness Config" (local:harness-config)
  12 new bookmarks (12 new stubs)
   3 already in folder
   2 already archived from other folders (added here too)
   1 line skipped: t.co link (resolve manually)
Enrich: pnpm dev workflow start enrich --limit 12
```

## Out of scope (explicit)

Browser/Notes connectors, non-X links, a general links store, t.co resolution, envelope/dada.stream lift, any UI. If a future need appears, it starts as a new plan.

## D5 — two-machine database (MBP + Mini), tracked separately

The import feature writes to whatever `data/bookmarks.db` it runs against; it neither depends on nor changes this decision.

- **Recommended: single-home the DB on the Mini.** The dada.stream runtime substrate (ADR-012) already designates the Mini as the always-on primary running services over Tailscale. Worker + Temporal + `bookmarks.db` live there; the MBP runs commands via SSH (`ssh mini 'cd ~/projects/x-bookmarks-scraper && pnpm dev import ...'` — or paste-import from the MBP by piping stdin through ssh). Zero code changes, single-writer discipline preserved.
- **Optional durability add-on:** Litestream replicating the Mini's DB to S3/R2 — continuous backup + point-in-time restore, still single-writer.
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

- Folder resolution: resolveFolderArg(db, arg) — src/lib/resolve-folder.ts:5
- New named folders: upsertFolder(id, name) — src/lib/db/folder-repo.ts:21; id scheme local:<kebab-name>
- Stub write: upsertPartialTweet(...) — src/lib/db/tweet-write-repo.ts:129 (COALESCE-preserving)
- Bookmark write: upsertBookmark(tweetId, folderId): boolean — src/lib/db/bookmark-write-repo.ts:16
- Command wiring: src/cli/program.ts (createProgram) — register `import` alongside existing commands;
  follow the structure of an existing simple command (e.g. folder or browse) for layout under src/commands/.

## Hard constraints

- No workflow-code changes (src/temporal/** untouched). Do not start/stop Temporal, the worker,
  or any workflow — live singletons may be running.
- No new dependencies.
- No writes outside: src/commands/** (new import command), src/cli/program.ts (registration),
  src/types/** (only if a type is genuinely needed), tests/**.
- The command must never enqueue deletes or touch delete_queue/sync_state.

## Verification (no live infra required)

1. pnpm lint && pnpm typecheck && pnpm test
2. New tests/import-command.test.ts covering: URL forms (user/status, /i/status, bare id,
   query-string strip), t.co and non-X rejection with reasons, in-input dedupe, existing-folder
   resolution, new-folder creation (local: id), already-known tweet → bookmark row only,
   --dry-run writes nothing, report counts. Use a temp SQLite db per test (see tests/db.test.ts
   for the established pattern).
3. Manual smoke against a THROWAWAY copy: cp data/bookmarks.db /tmp/import-smoke.db and run
   the command with a 3-line paste against it (never the real data/bookmarks.db).

## Commit

Stage files by name. Subject-only conventional message: feat(import): add paste-driven X link import command
No body, no trailers, no attribution lines. Do NOT push.

## Report back

Reply with: the commit SHA, files touched, test count added, and any spec deviation you had
to make (with one-line justification). If the spec blocked you, stop and report instead of improvising.
```

## Acceptance (owner checklist)

- [ ] `pnpm dev import --folder "Harness Config" --dry-run links.txt` classifies correctly
- [ ] Real run creates folder `local:harness-config`, stubs appear via `pnpm dev status` / browse
- [ ] `workflow start enrich` fills them; they show up in the next digest
