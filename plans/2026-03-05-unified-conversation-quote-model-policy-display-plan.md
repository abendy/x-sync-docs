# Plan: Unified Conversation + Quote Graph (Model -> Policy -> Display)

**Status:** Complete
**Created:** 2026-03-05
**Source:** Consolidates:

- `.project/plans/2026-03-04-manual-enhance-targeted-policy-plan.md`
- `.project/plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md`

## Context

`conversation_id` is necessary but not sufficient for operator intent. Quotes (and some local reply/retweet relationships) can be semantically part of the same discussion while not sharing the same native conversation ID.

We already store local relationship primitives (`conversation_id`, `tweet_edges`) and have manual enrich policy infrastructure. What is missing is one coherent execution plan that:

1. defines deterministic local thread/graph model behavior,
2. defines conversation+quotes enrichment policy behavior and budgets,
3. exposes the model in browse output.

## Goals

1. Preserve native X semantics (`conversation_id`, edge types) while adding a deterministic local unified-thread graph view.
2. Make policy behavior explicit for conversation and quotes (including a combined path) without changing sync baseline guarantees.
3. Provide a first-pass `browse --tweet` thread view that is useful even with partial local data.

## Decisions (Locked For This Plan)

1. **Sequence:** implement in strict phases: model/db/types -> enrichment policy -> display.
2. **Sync boundary:** sync child enrich remains baseline and deterministic (`sync.atomic` behavior).
3. **Manual boundary:** heavier graph discovery remains manual (`workflow start enrich` profiles).
4. **Graph storage posture (v1):** keep edge storage as-is; use derived graph assembly for unified thread view.
5. **Partial-data contract:** display and traversal must tolerate stubs/unavailable/missing links deterministically.

## Phase 1: Core Model / DB / Types

### Scope

1. Add missing DB index for conversation lookup:
   - `CREATE INDEX IF NOT EXISTS idx_tweets_conversation ON tweets(conversation_id);`
2. Add/confirm query surfaces for graph assembly:
   - `getTweetsByConversationId(conversationId)`
   - `getTweetEdgesForRelated(relatedId)` (reverse lookup)
3. Add shared thread-graph type contract (seed, node, edge, source tags, traversal metadata).
4. Define deterministic traversal and assembly invariants:
   - BFS from seed with visited set (cycle-safe),
   - stable queue/order tie-breakers (timestamp then ID),
   - reply edges define hierarchy depth,
   - quote/retweet edges kept as adjacency labels (not hierarchy depth).
5. Define root/materialization behavior:
   - when seed has `conversation_id`, attempt root lookup (`id == conversation_id`) if locally available,
   - do not require external fetch in this phase.

### Required Invariants

1. No duplicate tweet nodes in a single assembled graph.
2. No duplicate edges after normalization.
3. Same seed + same local DB state => byte-for-byte stable assembled ordering.
4. Missing related records never crash assembly; they are represented as stubs/unknown targets.

## Phase 2: Enrichment Policy (Conversation + Quotes)

**Scope:**

1. Keep existing single-mode policies (`atomic`, `origin`, `conversation`, `quotes`) for compatibility.
2. Add a combined manual mode/lane for unified discovery:
   - `mode: "conversation_quotes"`
   - `policyLane: "manual.conversation_quotes"`
3. Add explicit budget partition for combined mode (deterministic split):
   - conversation sub-budget and quotes sub-budget,
   - explicit stop reasons per sub-budget exhaustion.
4. Add deterministic execution order for combined mode:
   - resolve target set -> conversation discovery pass -> quotes discovery pass,
   - each pass bounded by policy caps and run-level API budget.
5. Extend policy profile docs/examples for the combined mode.

### Policy/Data Contract

1. Discovered tweets remain tweet records only (no bookmark row creation).
2. Retry metadata remains lane-aware and bounded (`attempt_count`, `next_retry_at`, `last_error_kind`, `policy_lane`).
3. Outcome taxonomy remains: `enriched | unavailable | deferred_transient | failed_terminal | skipped_budget`.
4. Telemetry must break out discovery source (`seed`, `origin`, `conversation`, `quotes`) and lane.

## Phase 3: Display (`browse --tweet`)

**Scope:**

1. Add `-t, --tweet <id>` mode in `browse` to render local thread graph context.
2. Enforce mutual exclusivity with `--folder` and `--search`.
3. Thread collection behavior:
   - seed lookup from local tweets,
   - include `conversation_id` set when available,
   - walk `replied_to`, `quoted`, and `retweeted` edges bidirectionally,
   - cap rendered rows via thread-mode `--limit` (default higher than bookmark mode).
4. Rendering behavior:
   - reply depth indentation (2 spaces/level),
   - quote/retweet markers as labels,
   - seed marker,
   - explicit stub/unavailable markers.
5. Deterministic ordering:
   - chronological (`created_at` nulls last), then `id` tie-breaker.

### Display Contract (Partial Data)

1. Missing parent: render node at nearest known depth with missing-link note.
2. Stub node: render placeholder text, keep edge context.
3. Unavailable node: render unavailable marker, keep adjacency for graph continuity.

## Phase 4: Hardening, Docs, and Rollout

1. Update policy docs for combined mode and lane semantics.
2. Add/refresh config examples for:
   - atomic baseline,
   - conversation-only,
   - quotes-only,
   - conversation+quotes combined.
3. Add workflow/log observability checks for lane, mode, budget stops, and discovery counters.
4. Validate in staged rollout:
   - baseline atomic unchanged,
   - manual combined mode behind explicit profile selection.

## Non-Goals

1. No default-on high-fanout discovery in sync.
2. No unbounded full-graph crawl.
3. No intent-queue/dispatcher runtime reintroduction in this pass.
4. No rewrite of existing `tweet_edges` storage model.

## Files Expected To Change

| File | Purpose |
| --- | --- |
| `src/lib/db/schema.ts` | add `conversation_id` index |
| `src/lib/db/tweet-query-repo.ts` | conversation/reverse-edge queries |
| `src/lib/db/tweet-repo.ts` | pass-through query methods |
| `src/lib/db/client.ts` | pass-through query methods |
| `src/types/config.ts` | add combined mode type |
| `src/temporal/shared/enrich-types.ts` | add combined mode + lane |
| `src/temporal/workflows/enrich/index.ts` | lane/mode resolution + combined-mode orchestration |
| `src/temporal/activities/store.ts` | combined-mode discovery passes + budget accounting |
| `src/commands/workflow/start-command/enrich.ts` | CLI mode/lane handling + display |
| `src/commands/browse.ts` | `--tweet` graph assembly + render |
| `config/examples/enrichment-policy-profiles.v1.*.json` | combined-mode profile examples |
| `docs/enrichment-policies.md` | mode/lane docs update |
| `README.md` | CLI/docs update for `browse --tweet` and policy mode |

## Verification Matrix

1. `npx tsc --noEmit` passes.
2. DB tests:
   - conversation index/query behavior,
   - reverse-edge lookup for `replied_to | quoted | retweeted`.
3. Policy tests:
   - combined-mode validation and clamping,
   - lane resolution (`manual.conversation_quotes`),
   - deterministic budget partition + stop reasons.
4. Workflow/activity tests:
   - deterministic target resolution and traversal ordering,
   - bounded behavior under caps and exhausted budgets.
5. CLI/manual tests:
   - `workflow start enrich --policy <combined-profile> --tweet-id <id>`
   - `browse --tweet <id>` happy path + no-thread + missing-id + mutually-exclusive flags.
6. Regression check:
   - sync baseline behavior unchanged.

## Exit Criteria

1. One seed tweet can produce a deterministic unified local thread view that includes reply+quote (and labeled retweet context).
2. Manual enrich supports conversation+quotes combined execution with bounded, observable budgets.
3. Sync baseline remains atomic/deterministic and unaffected by manual heavy policy additions.
4. Documentation and examples reflect the final mode/lane model.
