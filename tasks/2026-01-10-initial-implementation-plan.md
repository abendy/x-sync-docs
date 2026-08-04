# X Bookmarks Scraper - Implementation Plan

## Overview

CLI tool that syncs X (Twitter) bookmarks to a local SQLite database, then deletes them from X to access older bookmarks (due to API's ~800 bookmark depth limit). Supports bookmark folders and provides a TUI for browsing saved bookmarks.

## Tech Stack (Matching bird project)

- **Package Manager:** pnpm
- **Language:** TypeScript (ES2022, NodeNext modules)
- **Linting:** Biome + Oxlint (type-aware)
- **Testing:** Vitest
- **CLI/TUI:** Commander.js + Ink (React-based terminal UI)
- **Database:** better-sqlite3
- **HTTP Client:** `twitter-api-sdk` (official X SDK from @xdevplatform)

## Rate Limits (Configurable via .env)

| Tier | GET Bookmarks | DELETE Bookmark |
| --- | --- | --- |
| Free | 1 req / 15 min | 1 req / 15 min |
| Paid | 5 req / 15 min | 5 req / 15 min |

## API Endpoints Used

| Endpoint | Purpose | Max Results |
| --- | --- | --- |
| `GET /2/users/:id/bookmarks` | Fetch bookmarks | 100/req, 800 total |
| `GET /2/users/:id/bookmarks/folders` | List folders | paginated |
| `GET /2/users/:id/bookmarks/folders/:folder_id` | Folder bookmarks | 100/req |
| `DELETE /2/users/:id/bookmarks/:tweet_id` | Remove bookmark | 1 at a time |

## Optimal Sync Strategy

Given rate limits and API constraints:

1. **Batch GET**: Fetch 100 bookmarks per request (max allowed)
2. **Store ALL before DELETE**: Verify each tweet is in DB before any deletion
3. **Sequential DELETE**: Must delete one-by-one (no batch endpoint)
4. **Rate limit aware**: Track remaining calls, countdown to next window

For **Free tier** (1 call/15min shared):

- 1 GET (100 tweets) → store all → 100 DELETEs = 101 calls = ~25 hours for 100 tweets

For **Paid tier** (5 calls/15min):

- Much faster: ~5 hours for 100 tweets

## Project Structure

```text
x-bookmarks-scraper/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── .env.example
├── .husky/
│   └── pre-commit           # lint + typecheck + test
├── src/
│   ├── cli.ts               # Entry point with shebang
│   ├── index.ts             # Library exports
│   ├── cli/
│   │   └── program.ts       # Commander.js setup
│   ├── commands/
│   │   ├── sync.ts          # Main sync command (all or by folder)
│   │   ├── folders.ts       # List bookmark folders
│   │   ├── browse.ts        # TUI browser for local bookmarks
│   │   ├── status.ts        # Show db stats
│   │   └── auth.ts          # Verify/test auth
│   ├── lib/
│   │   ├── api.ts           # X API client (twitter-api-sdk)
│   │   ├── db.ts            # SQLite operations
│   │   ├── rate-limiter.ts  # Rate limiting with countdown
│   │   ├── config.ts        # Env config loader
│   │   └── logger.ts        # Terminal + file logging
│   ├── tui/
│   │   ├── SyncApp.tsx      # Sync progress TUI
│   │   └── BrowseApp.tsx    # Bookmark browser TUI
│   └── types/
│       └── index.ts
├── tests/
│   ├── db.test.ts
│   ├── rate-limiter.test.ts
│   └── api.test.ts
├── logs/                    # gitignored
│   └── sync-YYYY-MM-DD.log
└── data/                    # gitignored
    └── bookmarks.db
```

## Configuration

### .env.example

```env
# X API Credentials (OAuth 2.0)
X_CLIENT_ID=
X_CLIENT_SECRET=
X_ACCESS_TOKEN=
X_REFRESH_TOKEN=
X_USER_ID=

# Rate limit tier: "free" or "paid"
API_TIER=free

# Override intervals (ms) - optional
# Free default: 900000 (15 min), Paid default: 180000 (3 min)
SYNC_INTERVAL_MS=

# Sync specific folder only (optional, folder ID)
SYNC_FOLDER_ID=

# Logging
LOG_LEVEL=info              # debug | info | warn | error
LOG_DIR=./logs
```

## Database Schema

### All Available API Fields (Request with expansions)

```typescript
// tweet.fields (all)
attachments, author_id, context_annotations, conversation_id, created_at,
edit_controls, edit_history_tweet_ids, entities, geo, id, in_reply_to_user_id,
lang, non_public_metrics, organic_metrics, possibly_sensitive, promoted_metrics,
public_metrics, referenced_tweets, reply_settings, source, text, withheld

// user.fields (all)
created_at, description, entities, id, location, name, pinned_tweet_id,
profile_image_url, protected, public_metrics, url, username, verified, withheld

// media.fields (all)
alt_text, duration_ms, height, media_key, non_public_metrics, organic_metrics,
preview_image_url, promoted_metrics, public_metrics, type, url, variants, width

// place.fields (all)
contained_within, country, country_code, full_name, geo, id, name, place_type

// poll.fields (all)
duration_minutes, end_datetime, id, options, voting_status

// expansions (all)
attachments.media_keys, attachments.poll_ids, author_id, edit_history_tweet_ids,
entities.mentions.username, geo.place_id, in_reply_to_user_id,
referenced_tweets.id, referenced_tweets.id.author_id
```

### SQLite Schema

```sql
-- Bookmark folders
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- Main tweets table (normalized, extracted from full_json)
CREATE TABLE tweets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  author_id TEXT NOT NULL,
  in_reply_to_user_id TEXT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  lang TEXT,
  source TEXT,
  possibly_sensitive INTEGER DEFAULT 0,
  reply_settings TEXT,
  -- Public metrics (denormalized for queries)
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  quote_count INTEGER DEFAULT 0,
  -- Full API response for complete data
  full_json TEXT NOT NULL,
  -- Sync metadata
  synced_at TEXT NOT NULL,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  url TEXT,
  profile_image_url TEXT,
  verified INTEGER DEFAULT 0,
  protected INTEGER DEFAULT 0,
  followers_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  created_at TEXT,
  full_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- Media attachments
CREATE TABLE media (
  media_key TEXT PRIMARY KEY,
  tweet_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- photo, video, animated_gif
  url TEXT,
  preview_image_url TEXT,
  alt_text TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  full_json TEXT NOT NULL,
  FOREIGN KEY (tweet_id) REFERENCES tweets(id)
);

-- Bookmark tracking (which tweets are bookmarked, in which folder)
CREATE TABLE bookmarks (
  tweet_id TEXT NOT NULL,
  folder_id TEXT,                  -- NULL = no folder / all bookmarks
  bookmarked_at TEXT,              -- When originally bookmarked (if available)
  synced_at TEXT NOT NULL,
  deleted_from_x INTEGER DEFAULT 0,
  deleted_at TEXT,
  PRIMARY KEY (tweet_id, folder_id),
  FOREIGN KEY (tweet_id) REFERENCES tweets(id),
  FOREIGN KEY (folder_id) REFERENCES folders(id)
);

-- Sync log for debugging
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,            -- fetch | store | delete | error
  tweet_id TEXT,
  folder_id TEXT,
  details TEXT,
  success INTEGER DEFAULT 1
);

-- Indexes
CREATE INDEX idx_tweets_author ON tweets(author_id);
CREATE INDEX idx_tweets_created ON tweets(created_at);
CREATE INDEX idx_bookmarks_synced ON bookmarks(synced_at);
CREATE INDEX idx_bookmarks_deleted ON bookmarks(deleted_from_x);
CREATE INDEX idx_media_tweet ON media(tweet_id);
CREATE INDEX idx_sync_log_timestamp ON sync_log(timestamp);
```

## Core Sync Logic

```text
Phase 1: FETCH (batch)
─────────────────────
1. GET folders (if not cached)
2. GET /2/users/:id/bookmarks OR /2/users/:id/bookmarks/folders/:folder_id
   - Request ALL fields and expansions
   - max_results=100 (maximum allowed)
3. Parse response, extract tweets + users + media
4. For each tweet:
   a. INSERT user (upsert)
   b. INSERT tweet (upsert)
   c. INSERT media (upsert)
   d. INSERT bookmark record
   e. Log to sync_log

Phase 2: VERIFY (critical!)
───────────────────────────
Before ANY delete, verify:
1. Tweet exists in tweets table with full_json NOT NULL
2. User exists in users table
3. Bookmark record exists with deleted_from_x = 0
4. Log verification result

Phase 3: DELETE (one-by-one)
────────────────────────────
For each verified bookmark:
1. Wait for rate limit (countdown timer)
2. DELETE /2/users/:id/bookmarks/:tweet_id
3. On success:
   - UPDATE bookmarks SET deleted_from_x = 1, deleted_at = NOW()
   - Log success
4. On error:
   - Log error with full response
   - Continue to next (don't abort)

Phase 4: RESUME
───────────────
Track sync state for resume capability:
- Last pagination token
- Last processed tweet_id
- Pending deletes (verified but not yet deleted)
```

## TUI Features (Ink)

### Sync TUI (`SyncApp.tsx`)

- Spinner with current phase: "Phase 1: Fetching bookmarks..."
- Progress bar: `[████████░░] 42/100 tweets stored`
- Rate limit countdown: `⏳ Next request in: 14:32`
- Live stats panel:

  ```text
  ┌─ Sync Progress ─────────────────────┐
  │ Fetched:  100  │  Stored:  98       │
  │ Verified: 98   │  Deleted: 42       │
  │ Errors:   2    │  Pending: 56       │
  └─────────────────────────────────────┘
  ```

- Error list (scrollable)
- Keyboard: `q` quit, `p` pause, `r` resume

### Browse TUI (`BrowseApp.tsx`)

- Folder list sidebar (arrow keys to navigate)
- Tweet list with author, date, preview
- Full tweet view with media info
- Search/filter by text, author, date range
- Keyboard navigation (vim-style: j/k, gg, G)
- Open tweet in browser: `o` key

## Logging

### Terminal Output

- Colored by level: debug(gray), info(cyan), warn(yellow), error(red)
- Timestamps: `[2024-01-15 14:32:01]`
- Structured: `[INFO] [SYNC] Stored tweet 123456789`

### File Logging (`logs/sync-YYYY-MM-DD.log`)

- JSON Lines format for parsing
- Full context: action, tweet_id, folder_id, duration_ms, error details
- Rotation: daily files, configurable retention
- Example:

  ```json
  {"ts":"2024-01-15T14:32:01Z","level":"info","action":"store","tweet_id":"123","duration_ms":45}
  {"ts":"2024-01-15T14:32:02Z","level":"error","action":"delete","tweet_id":"456","error":"429 rate limited"}
  ```

## CLI Commands

```bash
# Sync all bookmarks
pnpm dev sync

# Sync specific folder
pnpm dev sync --folder <folder_id>

# List folders
pnpm dev folders

# Browse local bookmarks (TUI)
pnpm dev browse

# Show database stats
pnpm dev status

# Verify auth is working
pnpm dev auth
```

## Pre-commit Hook (.husky/pre-commit)

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

pnpm run lint && pnpm run typecheck && pnpm test
```

## Package.json Scripts

```json
{
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsc",
    "start": "node dist/cli.js",
    "lint": "pnpm run lint:biome && pnpm run lint:oxlint",
    "lint:biome": "biome check .",
    "lint:oxlint": "oxlint --tsconfig tsconfig.json --deny-warnings src tests",
    "lint:fix": "biome check --write . && oxlint --fix src tests",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepare": "husky"
  }
}
```

## Implementation Steps

### Phase 1: Project Scaffolding

1. Initialize pnpm project with package.json
2. Copy tsconfig.json from bird (adapted)
3. Copy biome.json from bird
4. Set up Vitest config
5. Create directory structure
6. Install dependencies

### Phase 2: Database Layer

1. Install better-sqlite3
2. Create db.ts with schema initialization
3. Implement CRUD operations
4. Write unit tests

### Phase 3: API Client

1. Install twitter-api-sdk (official X SDK)
2. Create api.ts wrapping the client
3. Implement getBookmarks() with ALL fields/expansions
4. Implement getFolders() and getBookmarksByFolder()
5. Implement deleteBookmark()
6. Create rate-limiter.ts with configurable intervals
7. Write unit tests with mocks

### Phase 4: CLI/TUI

1. Set up Commander.js program
2. Create SyncApp.tsx with progress display
3. Create BrowseApp.tsx for bookmark browser
4. Implement sync command (with --folder option)
5. Implement folders command
6. Implement browse command
7. Implement status command
8. Add auth verification command
9. Set up logger.ts for terminal + file logging

### Phase 5: Pre-commit & Polish

1. Install and configure Husky
2. Create pre-commit hook
3. Add .env.example
4. Test full workflow

## Verification

1. Run `pnpm dev sync` - should fetch, store, and delete bookmarks
2. Run `pnpm dev status` - should show database stats
3. Check SQLite: `sqlite3 data/bookmarks.db "SELECT COUNT(*) FROM bookmarks"`
4. (Optional) Use bird to verify bookmarks are removed from X

## Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "commander": "^14.0.0",
    "dotenv": "^16.0.0",
    "ink": "^6.6.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "kleur": "^4.1.5",
    "react": "^19.2.0",
    "twitter-api-sdk": "^1.2.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.0",
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.0",
    "husky": "^9.0.0",
    "oxlint": "^1.36.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
```

## Safety & Verification Checklist

Before each DELETE:

- [ ] Tweet ID exists in `tweets` table
- [ ] `full_json` column is NOT NULL and valid JSON
- [ ] User record exists in `users` table
- [ ] Bookmark record exists with `deleted_from_x = 0`
- [ ] Log verification result before proceeding

## Notes

- The X API only returns ~800 most recent bookmarks, so deleting after sync is essential to access older ones
- Official SDK: `twitter-api-sdk` from @xdevplatform (supports OAuth 2.0, typed responses)
- Folder endpoint: `GET /2/users/:id/bookmarks/folders` and `GET /2/users/:id/bookmarks/folders/:folder_id`
- bird integration: Can shell out to `bird bookmarks` to verify deletion (optional enhancement)
- Rate limit headers: Check `x-rate-limit-remaining` and `x-rate-limit-reset` in responses
