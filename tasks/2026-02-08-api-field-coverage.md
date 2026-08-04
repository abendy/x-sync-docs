# Expand X API field coverage for live tracking

Beyond bookmark archival, this tool will support ongoing profile scans, stream ingestion, and intelligent conversation/topic tracking. These additional fields become relevant in that context — capturing relationship signals, user metadata, and richer tweet context for filtering, prioritization, and analysis.

## Reference

- https://docs.x.com/x-api/fundamentals/data-dictionary
- https://docs.x.com/x-api/fundamentals/fields
- https://docs.x.com/x-api/fundamentals/expansions
- https://docs.x.com/x-api/fundamentals/post-annotations
- https://docs.x.com/x-api/fundamentals/metrics
- https://docs.x.com/x-api/fundamentals/conversation-id

## Remaining fields

| # | Category | Field | Notes |
| --- | --- | --- | --- |
| 1 | user.fields | `profile_banner_url` | Full profile capture for user profiles |
| 2 | tweet.fields | `card_uri` | Link/embed metadata for topic tracking |
| 3 | tweet.fields | `community_id` | Community-aware conversation tracking |
| 4 | tweet.fields | `scopes` | Tweet visibility context |
| 5 | user.fields | `subscription_type` | Premium tier context for user profiles |
| 6 | user.fields | `is_identity_verified` | Trust signal for prioritization |
| 7 | user.fields | `verified_followers_count` | Influence signal |
| 8 | user.fields | `subscription` | Subscription details |
| 9 | user.fields | `most_recent_tweet_id` | Detect active vs inactive accounts |
| 10 | user.fields | `connection_status` | Filter/prioritize by relationship (following, followed_by, blocking, muting) |
| 11 | expansions | `article.cover_media` | Article cover images |
