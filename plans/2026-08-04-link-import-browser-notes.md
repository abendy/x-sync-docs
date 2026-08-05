# Link Import — Browser Bookmarks & iOS Notes

Date: 2026-08-04
Repository: x-bookmarks-scraper
Status: Draft — decision points below need owner sign-off before implementation

> Scope note: the owner has suspended the 2026-04-27 feature pause for this initiative. The pause doc otherwise stands.

## Summary

Saved links live in three places today: X bookmarks (synced by this tool), browser bookmarks, and iOS Notes. This plan unifies them by splitting imports along one line: **links to X posts** are folded into the existing tweet pipeline as stubs (enrichment does the rest, and they appear in digests automatically); **all other web links** land in a small separate links store that the digest/query layer reads alongside the tweet archive, shaped so it lifts cleanly into dada.stream content envelopes later.

## Why the split

- An `x.com/<user>/status/<id>` link *is* a tweet reference. The schema was built for exactly this: `upsertPartialTweet()` creates a stub (`full_json IS NULL`), EnrichWorkflow fills it, media downloads follow. Zero new fetch code; existing digests pick them up.
- A generic web link is not a tweet and does not belong in `tweets`/`bookmarks` (ADR 024: this repo is the X datasource). A separate store keeps the boundary honest while still giving agents one query surface.

## Phase 1 — `import` command, X links only

New CLI command; local, no Temporal required:

```
pnpm dev import file <path>        # Netscape bookmarks HTML export, markdown, or plain URL list
pnpm dev import chrome [--profile Default]   # reads Chrome's live Bookmarks JSON directly
pnpm dev import --dry-run ...      # classify + report, write nothing
```

Behavior:

1. Extract URLs; partition into X-status links vs other (unwrap t.co where trivially possible).
2. For each X link: parse tweet id → `upsertPartialTweet(id)` + bookmark row.
3. Report: N X links imported (M already known), K web links skipped (Phase 1) or stored (Phase 2), dupes, unparseable lines.
4. Enrichment: report the new stub count and suggest `pnpm dev workflow start enrich`; do not auto-start.

Provenance (decision point D1): how to mark imported bookmarks.
- **Option A — pseudo-folder rows** (`folders.id = 'import:chrome'`, name `Imported: Chrome`): zero schema change, flows through every existing folder-scoped query, browse, and digest untouched. Cost: non-X rows in a table that mirrors X folders; sync code must never try to sync them (guard: folder ids are numeric strings from X; prefix `import:` cannot collide).
- Option B — `source` column on `bookmarks` (runtime migration, repo convention): cleaner semantics, but every folder-scoped surface ignores it until taught otherwise.
- Recommendation: **A** for the interim (visibility for free), revisit at envelope migration.

Dedupe: PK `(tweet_id, folder_id)` + COALESCE upsert already handles re-imports; a tweet imported from Chrome that later appears in a real X folder simply gains a second bookmark row — consistent with existing multi-folder semantics.

## Phase 2 — links store for non-X URLs

Separate database `data/links.db` (decision point D2 below), minimal schema shaped like a content envelope:

```sql
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  url_canonical TEXT NOT NULL UNIQUE,   -- lowercased host, stripped tracking params
  title TEXT,                            -- from bookmark metadata when present
  note TEXT,                             -- surrounding note text (iOS Notes)
  source TEXT NOT NULL,                  -- 'chrome' | 'safari' | 'ios-notes' | 'file'
  source_context TEXT,                   -- browser folder path / note title
  saved_at TEXT,                         -- bookmark add-date when the source has it
  imported_at TEXT NOT NULL
);
```

No fetching/enrichment in this phase — store what the source gives us. Title/description fetch is a later iteration if wanted.

D2 — where the links store lives:
- **Option A — separate `data/links.db`**: keeps the X-datasource DB pure; the query skill reads both files (SQLite ATTACH makes cross-DB queries trivial).
- Option B — `links` table inside `bookmarks.db`: one file, but muddies the service boundary and every backup/restore story.
- Recommendation: **A**.

## Phase 3 — iOS Notes extraction

Notes sync to macOS Notes.app via iCloud. Extraction via `osascript` (JXA) pulling note bodies from a named folder, then URL-parsing the text — first run triggers a one-time Automation permission prompt the owner must approve.

D3 — scope: which Notes folder(s) hold link saves, or scan all notes? Owner to name them.

Fallback if AppleScript access is refused: Share-sheet export to files, fed through `import file`.

## Phase 4 — digest & skill integration

- Update the bookmarks query guidance (skill) so digest agents read `links.db` alongside tweet bookmarks — one briefing over all sources.
- Imported X stubs appear in digests only after enrichment; the digest provenance section should report the pending-stub count so briefings are honest about coverage.

## Later — dada.stream envelope lift

When the scraper migrates to `components/x-sync/`, imported X bookmarks travel with the tweet archive. The links store maps 1:1 onto content envelopes (`source: chrome/ios-notes`, `sourceId: url_canonical`) and becomes either a tiny `links-datasource` component or a one-shot backfill into prism ingest. The Phase 2 schema is deliberately envelope-shaped so this is a mapping, not a redesign.

## Decision points (owner)

| # | Question | Recommendation |
|---|----------|----------------|
| D1 | Provenance marker for imported X bookmarks | pseudo-folders (`import:<source>`) |
| D2 | Links store location | separate `data/links.db` |
| D3 | Which iOS Notes folders to scan | owner to name |
| D4 | Which browsers | Chrome first (live JSON is trivial); Safari plist later if needed |

## Sequencing

1. Phase 1 (`import file` + `import chrome`, X links, dry-run first) — biggest win, feeds existing enrichment + digests.
2. Phase 2 (`links.db`) + Phase 4 skill update.
3. Phase 3 (Notes) once D3 is answered.
4. Envelope lift rides the monorepo migration, not this plan.
