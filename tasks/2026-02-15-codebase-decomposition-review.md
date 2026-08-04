# Review Plan: Codebase Decomposition for Multi-Service Architecture

## Context

This project is an architecture-first, composable, modularized single service that will become part of a larger ecosystem of sync services, classifiers, routing, and intelligence layers. The uncommitted changes decompose 11 large files (5,652 lines removed) into 108 new files across 14 new directories. The goal is to abstract earlier with the multi-service future in mind.

This plan structures a thorough review of all changes — assessing structure, clarity, robustness, and expandability — organized into focused passes that can be tackled one at a time.

---

## Scope Summary

| Category | Files | Lines (approx) |
| --- | ---: | ---: |
| Gutted originals (now re-exports) | 11 | ~60 remaining |
| New source files | 108 | ~6,200 |
| New directories | 14 | — |
| Deepest nesting | 4 levels | `commands/sync/bookmarks/local/` |

### New Directory Map

```text
src/
├── types/                          (5 files)  — Domain type split
├── lib/
│   ├── api/                        (9 files)  — API client decomposition
│   │   └── client/                 (6 files)  — Auth, endpoints, parsers, request, rate-limit
│   ├── db/                         (14 files) — Repository pattern
│   │   └── client/                 (7 files)  — DbOps adapter factories
│   ├── persistence/                (1 file)   — Shared persistence abstraction
│   ├── sync-engine/                (9 files)  — Phase-based engine
│   │   └── engine/phases/          (4 files)  — Individual phase implementations
│   └── sync-runner/                (6 files)  — Multi-page orchestration
├── commands/
│   ├── sync/                       (5 files)  — Sub-command split
│   │   └── bookmarks/              (5 files)  — Bookmark sync
│   │       └── local/              (3 files)  — Local (non-Temporal) path
│   └── workflow/                   (5 files)  — Sub-command split
│       ├── start-command/          (9 files)  — Per-workflow-type starters
│       └── status-command/         (3 files)  — Status display
└── temporal/
    ├── shared/                     (4 new files) — Type contracts
    └── workflows/
        ├── sync/                   (13 files) — Sync workflow decomposition
        └── enrich/                 (10 files) — Enrich workflow decomposition
```

---

## Review Passes

### Pass 1: Types & Contracts (`src/types/`, `src/temporal/shared/`)

**Files:** 9 total

- `src/types/{index,api,config,db,sync}.ts`
- `src/temporal/shared/{types,activity-types,enrich-types,sync-types,monitor-types}.ts`

**Review focus:**

- Are type boundaries clean across domain (API, DB, config, sync)?
- Do shared temporal types define clear contracts for the multi-service future?
- Any circular dependency risk between type modules?
- Are types exportable for consumption by sibling services?

**Preliminary findings:**

- Types split is clean: API response shapes, DB row types, config, sync state
- Temporal shared types use barrel re-export hub — good for contract evolution
- No circular deps detected

---

### Pass 2: Database Layer (`src/lib/db/`)

**Files:** 21 total (14 repos + 7 client ops)

- `src/lib/db/{client,schema,backoff}.ts`
- `src/lib/db/{user,media,folder,meta,outbox}-repo.ts`
- `src/lib/db/{tweet,tweet-query,tweet-write,tweet-maintenance}-repo.ts`
- `src/lib/db/{bookmark,bookmark-query,bookmark-write,delete-queue}-repo.ts`
- `src/lib/db/client/{index,user-ops,media-ops,folder-ops,meta-ops,tweet-ops,bookmark-ops}.ts`

**Review focus:**

- Is the 3-layer pattern (entity repo → sub-repo → DbOps adapter) justified?
- Are the DbOps adapters (thin delegation wrappers) adding value or ceremony?
- How are cross-repo dependencies handled? (circular closure pattern flagged)
- Is `Object.assign()` mixin approach on `BookmarksDb` type-safe enough?
- Which repos are appropriately sized vs over-split?
- Is the facade API (`BookmarksDb`) the right seam for the multi-service boundary?

**Preliminary findings (critical):**

- **Over-decomposition concern:** Simple entities (User=53 lines, Media=37, Folder=48) each get a repo + a DbOps adapter factory (18-30 lines of pure delegation). Six adapter files that just proxy 2-3 methods each.
- **Inconsistent granularity:** Tweet has 4 files (repo + query + write + maintenance = 515 lines), User has 1 file (53 lines). The split thresholds differ.
- **Circular dep handling:** `BookmarksDb` constructor uses `let bookmarkRepo!: BookmarkRepo` with deferred assignment + closure to break tweet↔bookmark circularity. Works but fragile.
- **`declare` + `Object.assign()` pattern:** 40+ method signatures declared on `BookmarksDb` but assigned at runtime. TypeScript won't catch if a mixin is missing.

---

### Pass 3: Persistence Layer (`src/lib/persistence/`)

**Files:** 1

- `src/lib/persistence/bookmark-store.ts` (112 lines)

**Review focus:**

- Is this the right abstraction boundary for cross-service reuse?
- Currently only `storeBookmarksBatch` — is this the start of a persistence interface?
- Both CLI (`sync-adapter.ts`) and Temporal (`activities/store.ts`) consume this — clean?

**Preliminary findings:**

- Good extraction — removes duplication between CLI and Temporal paths
- Could evolve into a persistence interface that other services implement
- Only 1 file — may need more members as the ecosystem grows

---

### Pass 4: API Client (`src/lib/api/`)

**Files:** 10 total

- `src/lib/api/{client,errors,fields,types}.ts`
- `src/lib/api/client/{auth-session,constants,endpoints,parsers,rate-limit,request}.ts`

**Review focus:**

- Naming: `api/client.ts` (file) vs `api/client/` (directory) — confusing?
- Is auth session management properly isolated for reuse?
- Are endpoint builders and parsers separable for other API consumers?
- Is `RateLimitError` the right error hierarchy for multi-service?

**Preliminary findings:**

- Clean separation of auth, endpoints, parsing, request, rate-limit
- The file/directory naming collision (`client.ts` + `client/`) is consistent but unusual
- Fields constants properly isolated — important for API version tracking

---

### Pass 5: Sync Engine & Runner (`src/lib/sync-engine/`, `src/lib/sync-runner/`)

**Files:** 15 total

- Engine: `{index,engine,types}.ts`, `engine/{types,state,retry}.ts`, `engine/phases/{backlog,fetch,store,process}.ts`
- Runner: `{index,types,page-loop,rate-limit-retry,stop-reason,aggregate}.ts`

**Review focus:**

- Is engine vs runner the right boundary? (single-page vs multi-page)
- Are phases composable — could a different service reuse individual phases?
- Type split: public `types.ts` vs internal `engine/types.ts` — clear?
- Same file/directory naming collision: `engine.ts` + `engine/`
- Does `sync-runner` depend on `sync-engine` or vice versa? (direction matters)

**Preliminary findings:**

- Boundary is clean: engine = single cycle, runner = loop orchestration
- Runner provides `withRateLimitRetry()` consumed by engine — dependency flows runner→engine which is correct
- Phase files are small (26-67 lines) and focused — good composability
- The `SyncOperations` interface is the key seam — any service implementing it can use the engine

---

### Pass 6: Temporal Workflows (`src/temporal/workflows/sync/`, `enrich/`)

**Files:** 23 total (13 sync + 10 enrich)

- Sync: `{index,activities,activity-types,signals,handlers,state,runtime,page-runner,rate-limit,helpers,enrich-orchestrator,finalize,result}.ts`
- Enrich: `{index,activities,activity-types,signals,runtime,loop,pass,rate-limit,records}.ts`

**Review focus:**

- Determinism: no `Date.now()`, no direct I/O in workflow code?
- Signal handling: are pause/resume/cancel cleanly isolated?
- Is `helpers.ts` a catch-all? (mixes phase mapping, error mapping, error detection)
- State management: `state.ts` mixes RuntimeState, EnrichRuntimeState, QueryState
- Child workflow orchestration (enrich-orchestrator): idempotent start, restart, signal forwarding
- Are workflow-local activity types redundant with shared types?

**Preliminary findings:**

- Determinism maintained — all I/O via activities, `wf.sleep()` for waits
- `helpers.ts` could be split (3 unrelated concerns in one file)
- `state.ts` bundles 3 state types + factories — could split by concern
- Activity types duplicated: `sync/activity-types.ts` + `shared/activity-types.ts` — need to verify these aren't redundant

---

### Pass 7: Commands (`src/commands/sync/`, `src/commands/workflow/`)

**Files:** 28 total (13 sync + 15 workflow)

- Sync: `register.ts`, `{state,folders,enrich}.ts`, `bookmarks/{register,types,callbacks,options,temporal}.ts`, `bookmarks/local/{run,output,summary}.ts`
- Workflow: `register.ts`, `{shared,control,list}.ts`, `start-command/{register,types,handlers,output,cycle-options,sync,enrich,topic-monitor,engagement-tracking}.ts`, `status-command/{register,display,progress}.ts`

**Review focus:**

- Is 4-level nesting (`commands/sync/bookmarks/local/run.ts`) justified?
- Are 1-line re-export files (`local.ts`, `start.ts`, `status.ts`) adding clarity or noise?
- Command registration pattern: consistent across sync and workflow?
- The workflow start-command has 9 files — could per-type handlers be collocated?
- `sync-adapter.ts` (202 lines, implements `SyncOperations`) — still in original location, not moved into the new structure

**Preliminary findings:**

- Deep nesting is the most visible concern — `bookmarks/local/` is deprecated (removal target 2026-04-15) so the complexity may be temporary
- Three 1-line files (`local.ts`, `start.ts`, `status.ts`) exist solely as barrel re-exports — questionable value
- Start-command has one file per workflow type (sync, enrich, topic-monitor, engagement-tracking) — scales well but 9 files for 4 workflow types feels heavy

---

### Pass 8: Cross-Cutting Concerns

**Review focus:**

- Do all gutted originals re-export correctly? (verified: yes, all are 1-9 line re-exports)
- Import graph: do new modules import from barrel re-exports or reach into internals?
- Does `pnpm typecheck` pass with the new structure?
- Do existing tests still pass without modification?
- Are there any new files that should have tests but don't?

**Verification steps:**

```bash
pnpm typecheck          # Type-check all files
pnpm test               # Run all existing tests
pnpm lint               # Check for import/style issues
```

---

## Execution Strategy

For each pass:

1. Read all files in the group
2. Assess structure, naming, boundaries, and expandability
3. Flag issues as **critical** (blocks correctness/maintainability), **concern** (worth discussing), or **note** (minor/stylistic)
4. Propose specific changes where warranted
5. Report findings before moving to next pass

Estimated effort: 8 passes, each producing a findings report. We tackle them sequentially so earlier findings (types, db) inform later reviews (workflows, commands).

---

## Verification Status

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Clean |
| `pnpm lint` | 180 files, 0 issues |
| `pnpm test` | 184 passed, 2 skipped (integration) |
| Re-exports | All 11 gutted originals verified correct |

**WIP Commit:** `78de3f0` on `develop`

---

## Review Findings

### Pass 1: Types & Contracts — No issues

- Type boundaries are clean: API response shapes (`api.ts`), DB row types (`db.ts`), config (`config.ts`), sync state (`sync.ts`)
- Temporal shared types use barrel re-export hub (`types.ts` → 4 sub-files) — good for contract evolution
- No circular dependencies between type modules (verified: no imports from `../types` within `types/`)
- Types are pure interfaces with no runtime imports — exportable for sibling services
- `monitor-types.ts` defines future workflow types (TopicMonitor, EngagementTracking) — clean forward declarations

---

### Pass 2: Database Layer — 2 concerns, 2 notes

#### [concern] DbOps adapter layer adds ceremony for small entities

`user-ops.ts` (18 lines) wraps `UserRepo` (53 lines) — 6 methods become 6 identical delegation calls. Same for `media-ops.ts` (18 lines) wrapping `MediaRepo` (37 lines). These adapters exist solely to provide interface types for `BookmarksDb` to `implements`, but the interfaces could be declared directly on the repos.

Six adapter files (`user-ops`, `media-ops`, `folder-ops`, `meta-ops`, `tweet-ops`, `bookmark-ops`) all follow the same pattern: define an interface, then create an object that proxies every method 1:1. Total: ~250 lines of pure delegation.

**Recommendation:** For the multi-service future, these interfaces *do* serve as the contract boundary — they define what `BookmarksDb` exposes without leaking repo internals. Accept the ceremony as the cost of clean contracts, but document why the layer exists (a one-line comment in `client/index.ts` would suffice).

#### [concern] `declare` + `Object.assign()` pattern

`BookmarksDb` uses 40+ `declare` statements (lines 30-84 of `client.ts`) and then `Object.assign(this, ...)` in the constructor. TypeScript won't error if a `createXxxDbOps()` factory is missing or returns a partial object — the `declare` tells TS "trust me, this exists at runtime." The `implements` clause provides some safety, but only if the interface and the factory stay in sync.

**Risk:** Medium. A missing factory would cause a runtime `undefined is not a function` error, not a compile-time error. The `implements` clause on line 27 mitigates this — if a factory doesn't return all methods of its interface, compilation fails. But if someone removes a factory call from `Object.assign` without removing the corresponding `implements`, the type system won't catch it.

**Recommendation:** Consider a single integration test that calls every method name on a fresh `BookmarksDb` to verify it's not `undefined`. This is cheaper than redesigning the mixin pattern.

#### [note] Circular dependency via deferred closure

Lines 96-105 in `client.ts`: `let bookmarkRepo!: BookmarkRepo` with closure-based cross-reference to `tweetRepo`. This breaks the tweet↔bookmark circularity (tweet writes need outbox events owned by bookmark, bookmark verify needs tweet query). The pattern works and is well-contained to one constructor.

#### [note] Inconsistent repo granularity

Tweet has 4 files (repo + query + write + maintenance = ~515 lines total), User has 1 file (53 lines). This is justified by complexity — tweet operations span migrations, FTS, COALESCE upserts, and edge tracking. User/Media/Folder are genuinely simple CRUD.

---

### Pass 3: Persistence Layer — No issues

- Good extraction — removes duplication between CLI and Temporal paths
- Clean shared interface with `StoreBookmarksInput`/`StoreBookmarksSummary`
- Could evolve into a persistence interface that other services implement
- Only 1 file — may need more members as the ecosystem grows

---

### Pass 4: API Client — Clean, 1 note

- Auth session isolated in `client/auth-session.ts` — reusable
- Endpoints, parsers, rate-limit, request all cleanly separated
- `RateLimitError` is a good error type for multi-service (carries `resetAt` and `retryAfterMs`)
- Fields versioning with `FIELDS_VERSION` and changelog comment is solid

#### [note] File/directory naming collision

`api/client.ts` (the main `XApiClient` class) and `api/client/` (the directory of internals) coexist. This is valid in the filesystem and TypeScript but unusual. Imports are unambiguous (`./client.js` vs `./client/foo.js`), so this is stylistic only.

---

### Pass 5: Sync Engine & Runner — Clean

- Boundary is clean: engine = single cycle, runner = loop orchestration
- `SyncOperations` interface is the key abstraction — implemented by `CliSyncOperations` (CLI) and `createSyncOps()` (Temporal). Any future service implementing this interface can use the engine.
- Phase files are small and focused (backlog=67, fetch=60, store=26, process=49 lines)
- `withRateLimitRetry()` is a clean generic utility consumed by the engine phases
- `resolvePostPageStopReason()` encapsulates the "when to stop paging" logic
- `accumulateSyncResult()` for aggregating across pages is straightforward
- Same file/directory naming collision: `engine.ts` + `engine/` (same stylistic note as API)

---

### Pass 6: Temporal Workflows — 2 concerns, 1 note

#### [concern] `helpers.ts` mixes unrelated concerns

`sync/helpers.ts` (73 lines) bundles 5 unrelated functions:

1. Phase mapping (`mapEnginePhase`, `mapErrorPhase`)
2. Error parsing (`mapSyncEngineErrors`)
3. Error detection (`isDuplicateChildStartError`, `isExternalWorkflowNotFoundError`)

These serve different consumers and have different change triggers. Phase mapping is used by `runtime.ts`, error parsing by `result.ts`, error detection by `enrich-orchestrator.ts`.

**Recommendation:** Consider splitting into `phase-mapping.ts` and `error-detection.ts`. The file is small enough that this is low priority.

#### [concern] Workflow-local vs shared activity types drift risk

`sync/activity-types.ts` defines a `SyncActivities` interface with inline `import()` types. `shared/activity-types.ts` defines the same shapes as named `Input`/`Output` interfaces. These aren't redundant — they serve different purposes:

- **Shared:** Contract types for activity implementations (used by `activities/store.ts`, `activities/fetch.ts`, etc.)
- **Workflow-local:** TypeScript interface for the `proxyActivities<T>()` generic parameter

However, the shapes must stay in sync manually. If `StoreBookmarksInput` in `shared/` gains a field, `SyncActivities.storeBookmarks` in `sync/activity-types.ts` must be updated too.

**Recommendation:** Have `SyncActivities`/`EnrichActivities` reference the shared types directly instead of inlining:

```typescript
storeBookmarks: (input: StoreBookmarksInput) => Promise<StoreBookmarksOutput>;
```

This eliminates drift risk.

#### [note] `RuntimeState` interface split across files

`sync/state.ts` defines `EnrichRuntimeState`, `QueryState`, and factories for all three state objects plus `createProcessErrorRecorder`. The `RuntimeState` interface itself is defined in `runtime.ts` (not `state.ts`). This split is slightly confusing — `RuntimeState` in `runtime.ts`, but `createRuntimeState()` in `state.ts`.

**Recommendation:** Move `RuntimeState` to `state.ts` (where its factory lives), or consolidate both into one file.

---

### Pass 7: Commands — 2 concerns, 1 note

#### [concern] 4-level nesting depth

`commands/sync/bookmarks/local/run.ts` is 4 levels deep. The `local/` directory contains 3 files for the deprecated `--local` path (removal target 2026-04-15). Since this is a deprecation target, the deep nesting is temporary but adds cognitive overhead until removal.

**Recommendation:** When `--local` is removed, the `local/` directory collapses naturally. For now, accept the depth — it correctly isolates deprecated code.

#### [concern] Three 1-line barrel re-export files

- `bookmarks/local.ts`: `export { runLocalSync } from './local/run.js';`
- `workflow/start.ts`: `export { registerWorkflowStart } from './start-command/register.js';`
- `workflow/status.ts`: `export { registerWorkflowStatus } from './status-command/register.js';`

These exist so that parent modules can import from a shorter path. The value is marginal — the parent could import directly from the nested path. But they do provide a stable import surface if the internal structure changes.

**Recommendation:** Keep them for now. They're harmless and provide a minor decoupling benefit.

#### [note] Start-command has 9 files for 4 workflow types

Each workflow type gets its own file (`sync.ts`, `enrich.ts`, `topic-monitor.ts`, `engagement-tracking.ts`), plus shared infrastructure (`register.ts`, `types.ts`, `handlers.ts`, `output.ts`, `cycle-options.ts`). This is more files than strictly necessary, but scales well — adding a new workflow type means adding one file, not modifying a shared switch statement.

---

### Pass 8: Cross-Cutting Concerns — Clean

- All 11 gutted originals are correct re-export barrels (verified)
- Existing tests pass without modification (184/184)
- No new files lack test coverage that had coverage before — tests import from the original paths which now re-export from the new structure
- Import graph is clean: new modules import from `../../types/index.js` (the barrel) not from internal paths of other decomposed modules

---

## Priority Actions

| # | Severity | Area | Action | Status |
| --- | --- | --- | --- | --- |
| 1 | **concern** | Temporal: activity types drift | Have `SyncActivities`/`EnrichActivities` reference shared types instead of inlining | Done (`014edba`) |
| 2 | **concern** | DB: `declare`+`Object.assign` safety | ~~Add a smoke test~~ → Replaced with explicit delegation methods | Done (`014edba`) |
| 3 | **concern** | Temporal: `RuntimeState` split | Move `RuntimeState` factory to `runtime-state.ts` | Done (`014edba`) |
| 4 | **note** | Temporal: `helpers.ts` | Split into `phase-mapping.ts`, `error-mapping.ts`, `workflow-errors.ts`, `constants.ts` | Done (`014edba`) |
| 5 | **note** | DB: DbOps ceremony | ~~Document why the adapter layer exists~~ → Removed entire DbOps adapter layer | Done (`014edba`) |
| 6 | **note** | Commands: barrel re-exports | Removed 3 unnecessary 1-line re-exports (`local.ts`, `start.ts`, `status.ts`) | Done (`014edba`) |
| — | **note** | API: naming collision | Renamed `api/client.ts` → `api/x-api-client.ts` | Done (`014edba`) |
| — | **note** | Sync engine: naming collision | Renamed `sync-engine/engine.ts` → `sync-engine/sync-engine-core.ts` | Done (`014edba`) |

---

## Overall Assessment

The decomposition is well-executed. The type boundaries are clean, the re-exports maintain backwards compatibility, all tests pass, and the `SyncOperations` interface provides a solid seam for multi-service evolution.

All priority actions have been resolved in commit `014edba`. Key outcomes:

- **DB layer:** Eliminated the entire DbOps adapter layer (7 files, ~250 lines) and replaced `declare` + `Object.assign()` with explicit typed delegation methods — compile-time safety instead of runtime trust
- **Temporal contracts:** Unified `SyncActivities`/`EnrichActivities` into `shared/activity-types.ts` — single source of truth, no drift risk
- **Workflow internals:** Split `helpers.ts` (3 concerns) into 4 focused files; split `state.ts` (3 state types) into 4 focused files
- **Naming:** Resolved both file/directory naming collisions (`client.ts`/`client/`, `engine.ts`/`engine/`)
- **Barrel re-exports:** Removed 3 unnecessary 1-line re-exports; consumers now import directly

**Net result:** 39 files changed, +448, -572 lines. Verification: typecheck clean, lint clean (174 files), 184 tests passed.
