# Task: Thread-Aware Enrichment Code Review Findings

**Status:** Complete
**Created:** 2026-02-22
**Completed:** 2026-02-22
**Scope Reviewed:** `fed10593`, `4b808f00`, `36e0f30d`, `841c5c58`, `5c0aecdf`
**Plan Reference:** `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`

## Summary

The implementation is solid overall and test coverage is strong, but there are a few important correctness gaps in conversation expansion behavior and one robustness gap in the batch-fallback fetch path.

## Findings (Ordered by Severity)

### 1) High: Conversation post cap is not strictly enforced per page

**Evidence:**

1. `src/temporal/activities/store.ts:309` loop condition checks `discoveredInConversation < maxConversationPosts`.
2. `src/temporal/activities/store.ts:314` computes remaining posts for the conversation.
3. `src/lib/api/client/endpoints.ts:79` enforces `max_results >= 10` for recent search.
4. `src/temporal/activities/store.ts:334` iterates all tweets in returned page without an in-loop `maxConversationPosts` guard.
5. `src/temporal/activities/store.ts:373` increments `discoveredInConversation` after processing full page.

**Impact:**

When `maxConversationPosts` is less than 10 (or near remaining budget), one search page can still return up to 10 posts and the loop may process all of them, exceeding the configured hard cap for conversation expansion in a single pass.

**Recommended Fix:**

Add an in-loop guard in the conversation page processing loop to stop adding tweets once the remaining per-conversation post budget reaches zero, independent of requested `max_results`.

### 2) Medium: Duplicate conversation tweets can consume conversation budget incorrectly

**Evidence:**

1. `src/temporal/activities/store.ts:348` adds tweet ID to each seed related set.
2. `src/temporal/activities/store.ts:349` sets `assignedToSeed = true` regardless of whether the set actually grew.
3. `src/temporal/activities/store.ts:356` increments `discoveredInPage` based on `assignedToSeed`, not on net new additions.

**Impact:**

If the same tweet appears again (or is already present via prior included tweets), it can still count toward `discoveredInConversation`, causing premature cap exhaustion and reduced effective recall.

**Recommended Fix:**

Track whether at least one `relatedSet.add(tweet.id)` increased set size (net-new discovery) before incrementing `discoveredInPage`.

### 3) Medium: Sequential batch fallback drops partial successes on single-item exception

**Evidence:**

1. `src/temporal/activities/fetch.ts:243` starts sequential fallback loop.
2. `src/temporal/activities/fetch.ts:255` performs per-ID fetch.
3. `src/temporal/activities/fetch.ts:278` catch handler replaces full batch result with `toBatchErrorResult(ids, ...)`.

**Impact:**

If one sequential fetch throws a non-rate-limit error mid-loop, already-fetched successful records are discarded and all IDs are returned as failed. This is less resilient and can create unnecessary retries.

**Recommended Fix:**

Wrap each per-ID fallback fetch in its own try/catch and preserve successful results already collected in `results`.

## Testing Gaps to Add

1. Add a conversation-mode test where `maxConversationPosts = 1` and the returned page has multiple tweets, asserting strict cap compliance.
2. Add a conversation-mode duplicate-page/duplicate-tweet test asserting duplicate tweets do not consume `maxConversationPosts`.
3. Add a fallback batch test where one sequential ID throws and prior successful IDs are preserved.

## Validation Performed

Ran targeted test suite:

1. `tests/config-enrich-policy.test.ts`
2. `tests/x-api-source.test.ts`
3. `tests/temporal-enrich-workflow.test.ts`
4. `tests/temporal-activities.test.ts`
5. `tests/temporal-fetch-activities.test.ts`
6. `tests/api.test.ts`

All passed in local run.

## Action Items

- [x] Fix strict per-page cap enforcement in conversation expansion.
- [x] Fix duplicate counting logic in conversation expansion.
- [x] Make sequential batch fallback preserve partial successes.
- [x] Add regression tests for all three cases above.

## Progress Updates

### 2026-02-22

1. Completed Finding #1 (strict conversation post-cap enforcement) and committed in `25171f1`.
2. Added/updated regression coverage for `maxConversationPosts = 1` with multi-tweet page input in `tests/temporal-activities.test.ts`.
3. Validation run: `pnpm exec vitest run tests/temporal-activities.test.ts` (pass), then full pre-commit suite (pass).
4. Completed Finding #2 (duplicate conversation tweets no longer consume cap unless net-new per seed set) with duplicate-page regression coverage in `tests/temporal-activities.test.ts`.
5. Validation run: `pnpm exec vitest run tests/temporal-activities.test.ts` (pass).
6. Completed Finding #3 (sequential fallback now preserves partial successes when one ID fails) with per-ID exception regression coverage in `tests/temporal-fetch-activities.test.ts`.
7. Validation run: `pnpm exec vitest run tests/temporal-fetch-activities.test.ts` (pass).
8. Completion commits: `25171f1`, `ac2830b`, `9fe6353`.
