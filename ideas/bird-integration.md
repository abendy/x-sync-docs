# Idea: Bird Integration for Unlimited API Access

## Problem

The official X API free tier has severe limitations:
- **100 posts/month** total
- Shared across GET and DELETE operations
- Insufficient for bulk bookmark scraping (hundreds/thousands of bookmarks)

Paid tier helps but still has rate limits and costs money.

## Solution: Bird

[bird](https://github.com/steipete/bird) is a CLI tool that uses X's internal GraphQL API via browser cookies. It has no official rate limits.

### Available Bookmark Operations

| Method | Purpose |
|--------|---------|
| `getBookmarks(count?)` | Fetch bookmarks (default 20) |
| `getAllBookmarks()` | Fetch ALL bookmarks, paginated |
| `getBookmarkFolderTimeline(folderId, count?)` | Fetch from specific folder |
| `getAllBookmarkFolderTimeline(folderId)` | Fetch ALL from folder |
| `unbookmark(tweetId)` | Delete bookmark |

Source: `src/lib/twitter-client-timelines.ts` and `src/lib/twitter-client-bookmarks.ts`

### GraphQL Query IDs

From `src/lib/query-ids.json`:
```json
{
  "Bookmarks": "RV1g3b8n_SGOHwkqKYSCFw",
  "BookmarkFolderTimeline": "KJIQpsvxrTfRIlbaRIySHQ",
  "DeleteBookmark": "Wlmlj2-xzyS1GN3a6cj-mQ"
}
```

## Integration Options

### 1. Shell out to bird CLI
```bash
bird bookmarks --count 100
bird unbookmark <tweet_id>
```
- Pros: Simple, no code changes to bird
- Cons: Parse CLI output, slower, requires bird installed

### 2. Import bird as library
```typescript
import { TwitterClient } from 'bird';
const client = new TwitterClient();
const bookmarks = await client.getAllBookmarks();
```
- Pros: Clean API, type-safe
- Cons: May not export client for library use

### 3. Port GraphQL logic
Copy bird's query IDs and request patterns into our codebase.
- Pros: No external dependency
- Cons: Maintenance burden, duplicated code

## Risks & Considerations

1. **Terms of Service** - Internal APIs are not officially supported
2. **API Stability** - Query IDs can change without notice (bird handles this with runtime refresh)
3. **Account Risk** - Aggressive usage could flag account
4. **Cookie Auth** - Requires browser cookies, not OAuth tokens

## Recommended Approach

**Hybrid strategy:**
- Use bird for initial bulk scrape (one-time, get all historical bookmarks)
- Use official API for ongoing maintenance syncs (low volume, stays within limits)
- Or: Use bird exclusively but with conservative rate limiting

## Status

- **Created**: 2025-01-11
- **Status**: Idea - not implemented
- **Priority**: Consider if API limits become blocking
