# Plan: `--no-folders` + `--no-delete` Sync Mode

**Status:** Complete
**Created:** 2026-03-04
**Source:** ~/.claude/plans/optimized-knitting-harp.md

## Context

There are a large number of bookmarks not saved to any X folder. The `--no-folders` sync mode fetches these via the all-bookmarks API endpoint, which — unlike the folder endpoint — returns **full tweet data** with all field expansions and supports **real cursor-based pagination** (100 items/page, unlimited pages). This mode has not been exercised in production yet. We need to verify pagination works at scale, confirm data completeness, and understand interactions with existing folder-synced records — all without destroying any bookmark data.

---

## Key Findings

### How `--no-folders` differs from folder sync

| Aspect | Folder Sync | No-Folders Sync |
| --- | --- | --- |
| API endpoint | `GET /bookmarks/folders/{id}` | `GET /bookmarks` |
| Data returned | IDs only (`ids_only`) | Full tweet data (`full`) |
| Pagination | 20 items, NO cursor | 100 items/page, cursor-based |
| Enrichment needed | Always (stubs) | No (full records) |
| Engine pages | Drain (unlimited) or `--pages N` | Always 1 (internal cursor loop) |
| `--pages` flag | Allowed | Forbidden |
| `--limit` flag | Not used | Caps total fetch |
| Bookmark `folder_id` | Specific folder ID | `NULL` |

### Critical: the delete queue danger with `folder_id = NULL`

**File**: `src/lib/db/delete-queue-repo.ts`

When `--no-delete` is used, the process phase calls `enqueueDelete(tweetId, null)` for every fetched bookmark. These queue entries accumulate.

If a subsequent run uses `--no-folders` **without** `--no-delete`, the backlog phase calls `enqueuePendingDeletes(null)` which seeds the queue from **ALL** bookmarks with `folder_id IS NULL` (not just the current run), then `getDeleteQueueReady(null)` returns them all for deletion. **This would attempt to delete every non-folder bookmark from X.**

We must clear the delete queue after testing, and we must **never** run `--no-folders` with deletes enabled until this behavior is understood/addressed.

### Pagination within a single engine page

This was true at plan creation time, but is no longer the intended long-term runtime shape. No-folder non-dry-run sync now has its own page-by-page outer loop, with immediate store/process per API page and a delete-reveal restart when cursor pagination appears to stop early.

Dry-run still exercises the internal fetch loop directly, which is why the `94` / `nextToken=none` result remained an important diagnostic.

### Investigation outcome

Testing found that the all-bookmarks endpoint can return a terminal-looking response (`94` items, no `nextToken`) even when the X app appears to show many more bookmarks. That is now treated as an API inconsistency to work around, not as a trustworthy stop signal for delete-enabled no-folder sync.

### Temporal side-effect to avoid during testing

Temporal sync can auto-trigger child workflows after store (notably media-download). For this test plan, use `--local` so runs stay isolated to sync behavior and don't kick off background media processing.

### NULL folder_id storage

Bookmarks are stored with `folder_id = NULL` in the `bookmarks` table (composite PK: `tweet_id, folder_id`). Per ADR 006, if these tweets are later synced via a specific folder, the NULL records get migrated (updated to the folder ID, not duplicated).

---

## Guardrails

1. **Database backup** before each phase: `cp data/bookmarks.db data/bookmarks.db.backup-$(date +%Y%m%d-%H%M%S)`
2. **Use `--dry-run` first** — fetches from API but does not store or delete
3. **Use `--limit N`** to cap fetch volume during initial tests
4. **Use `--no-delete`** when storing — queues instead of deleting
5. **Clean up delete queue** after `--no-delete` runs to prevent accidental future deletions
6. **Use `--local` for Steps 2-4** — synchronous output and no Temporal child workflows
7. **Standalone scripts** for DB inspection — no changes to main project code

---

## Test Steps

### Step 1: Baseline snapshot

Capture current DB state for comparison.

```bash
# Backup
cp data/bookmarks.db data/bookmarks.db.backup-$(date +%Y%m%d-%H%M%S)
```

```sql
-- Run via: sqlite3 data/bookmarks.db
-- Counts
SELECT 'tweets' as tbl, COUNT(*) FROM tweets
UNION ALL SELECT 'bookmarks', COUNT(*) FROM bookmarks
UNION ALL SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'media', COUNT(*) FROM media
UNION ALL SELECT 'delete_queue', COUNT(*) FROM delete_queue;

-- Bookmarks by folder
SELECT COALESCE(folder_id, 'NULL') as folder, deleted_from_x, COUNT(*)
FROM bookmarks GROUP BY folder_id, deleted_from_x ORDER BY folder_id;

-- Delete queue state
SELECT COALESCE(folder_id, 'NULL') as folder, COUNT(*) FROM delete_queue GROUP BY folder_id;
```

### Step 2: Dry-run pagination test (zero side effects)

**Goal**: Verify the all-bookmarks endpoint returns full data and pagination works.

```bash
# Small test — 1 API call, 10 items
pnpm dev sync --local --no-folders --dry-run --limit 10

# Medium test — 5 API calls, 500 items
pnpm dev sync --local --no-folders --dry-run --limit 500

# Full test — all bookmarks, follows cursors to exhaustion
pnpm dev sync --local --no-folders --dry-run
```

**What to check**:

- Sample output shows `@username: tweet text` (not `(stub - no content)`)
- No `Data completeness: ids_only` warning
- Total fetched count at the end
- Time taken and any rate limit pauses
- DB unchanged after (verify with baseline queries)

### Step 3: Store test with `--no-delete` (small batch)

**Goal**: Verify bookmarks are stored correctly with full data and `folder_id = NULL`.

```bash
# Fresh backup
cp data/bookmarks.db data/bookmarks.db.backup-phase3-$(date +%Y%m%d-%H%M%S)

# Store 10 items
pnpm dev sync --local --no-folders --no-delete --limit 10
```

**What to check**:

- Output shows `Full records: 10, Stub records: 0`
- No enrichment needed (full data from API)

```sql
-- Verify stored records
SELECT COUNT(*) FROM bookmarks WHERE folder_id IS NULL AND deleted_from_x = 0;

-- Verify tweet completeness (should all be 'full')
SELECT
  CASE WHEN full_json IS NOT NULL THEN 'full'
       WHEN text IS NOT NULL THEN 'partial'
       ELSE 'stub' END as level,
  COUNT(*)
FROM tweets t
JOIN bookmarks b ON b.tweet_id = t.id
WHERE b.folder_id IS NULL
GROUP BY level;

-- Check delete queue (queued, not deleted)
SELECT COUNT(*) FROM delete_queue WHERE folder_id IS NULL;

-- Check for overlap with folder-synced bookmarks
SELECT COUNT(DISTINCT b1.tweet_id)
FROM bookmarks b1 JOIN bookmarks b2 ON b1.tweet_id = b2.tweet_id
WHERE b1.folder_id IS NULL AND b2.folder_id IS NOT NULL;
```

### Step 4: Full store (if Step 3 passed)

```bash
cp data/bookmarks.db data/bookmarks.db.backup-phase4-$(date +%Y%m%d-%H%M%S)

pnpm dev sync --local --no-folders --no-delete
```

**What to check**:

- Total fetched matches dry-run count from Step 2
- `Stub records: 0`
- Existing folder bookmark counts unchanged from baseline

### Step 5: Delete queue cleanup

**Critical**: Remove queue entries created by `--no-delete` to prevent accidental deletion.

```bash
sqlite3 data/bookmarks.db "SELECT COUNT(*) FROM delete_queue WHERE folder_id IS NULL;"
# Note the count, then clear
sqlite3 data/bookmarks.db "DELETE FROM delete_queue WHERE folder_id IS NULL;"
# Verify
sqlite3 data/bookmarks.db "SELECT COUNT(*) FROM delete_queue WHERE folder_id IS NULL;"
# Should be 0
```

---

## Standalone Inspection Script

Create `scripts/inspect-no-folders.sh` (temporary, not part of main project):

```bash
#!/usr/bin/env bash
DB="${1:-data/bookmarks.db}"
echo "=== Bookmarks by folder ==="
sqlite3 "$DB" "SELECT COALESCE(folder_id,'NULL') f, deleted_from_x del, COUNT(*) cnt FROM bookmarks GROUP BY f, del ORDER BY f;"
echo ""
echo "=== Tweet completeness (NULL folder only) ==="
sqlite3 "$DB" "SELECT CASE WHEN full_json IS NOT NULL THEN 'full' WHEN text IS NOT NULL THEN 'partial' ELSE 'stub' END lvl, COUNT(*) FROM tweets t JOIN bookmarks b ON b.tweet_id=t.id WHERE b.folder_id IS NULL GROUP BY lvl;"
echo ""
echo "=== Delete queue ==="
sqlite3 "$DB" "SELECT COALESCE(folder_id,'NULL') f, COUNT(*) cnt, MAX(attempts) max_att FROM delete_queue GROUP BY f;"
echo ""
echo "=== Overlap: tweets in both NULL and folder records ==="
sqlite3 "$DB" "SELECT COUNT(DISTINCT b1.tweet_id) FROM bookmarks b1 JOIN bookmarks b2 ON b1.tweet_id=b2.tweet_id WHERE b1.folder_id IS NULL AND b2.folder_id IS NOT NULL;"
```

---

## Verification

After each step, run the inspection script and compare with baseline. Key success criteria:

1. All-bookmarks API returns `dataCompleteness: 'full'` (not `ids_only`)
2. Pagination follows cursors to exhaustion (total count is stable across runs)
3. Stored tweets have `full_json IS NOT NULL` (zero stubs); do not rely on completeness labels alone
4. Existing folder-scoped bookmark records are unchanged
5. No bookmarks marked as `deleted_from_x = 1` during `--no-delete` runs
6. Delete queue entries cleaned up after testing

## Notes
