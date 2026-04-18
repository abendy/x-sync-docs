# Project Review: TypeScript + Temporal, Carmack Edition

Date: 2026-03-07
Status: Complete

## Context

This review assumes the stated context:

- This is not just a one-off CLI. It is already behaving like an X datasource service with a CLI front-end.
- The codebase is part of a larger workflow/content-management application, so contracts and service boundaries are not automatically overengineering.
- Temporal is a strategic choice and is likely to stay.
- The question is not "why is there architecture here?" The real question is whether the current architecture is earning its complexity.

I also intentionally did not spend time re-raising older review items that have already been closed out, such as the original enrichment gap, header-aware rate limiting, or the first shared sync-engine extraction.

## Snapshot

Current shape from the working tree:

- `src`: 22,210 lines across 210 TypeScript files
- `tests`: 12,997 lines across 43 test files
- `docs`: 4,288 lines across 50 markdown files
- `pnpm typecheck`: clean
- `pnpm test`: 42 files passed, 1 skipped; 463 tests passed, 2 skipped

Largest complexity concentrations in `src`:

- `src/temporal/activities/store.ts` - 1087 lines
- `src/temporal/workflows/enrich/pass.ts` - 606 lines
- `src/temporal/activities/fetch.ts` - 477 lines
- `src/lib/db/client.ts` - 430 lines
- `src/temporal/workflows/sync/page-runner.ts` - 429 lines
- `src/temporal/workflows/orchestrator/index.ts` - 411 lines

Largest test concentration:

- `tests/temporal-sync-workflow.test.ts` - 1671 lines
- `tests/temporal-activities.test.ts` - 1183 lines
- `tests/db.test.ts` - 842 lines
- `tests/sync-command-routing.test.ts` - 804 lines

That size is larger than a simple CLI, but not crazy for an early datasource service with durable workflow orchestration, persistence, enrichment, delete coordination, outbox semantics, and a growing service-contract surface.

## Executive Take

The good news: this codebase is smarter than its LOC count. The architecture has real domain reasoning behind it. The Temporal usage is strongest exactly where the problem is actually durable and stateful: serialized sync scheduling, rate-limit sleeps, long-running retries, and cross-run coordination.

The bad news: the project is now paying a tax for being halfway between three identities at once:

1. a sharp CLI tool,
2. a durable datasource service, and
3. a homegrown TypeScript platform.

That tax shows up as multiple parallel truth systems, too much handwritten infrastructure, and a few places where the number of concepts is starting to outrun the actual product surface.

My overall verdict: the core direction is right, but the next wins come from compression, not expansion.

## What's Brilliant

- The architecture is domain-first, not framework-first. The ADRs and boundary docs in `docs/spec/BOUNDARIES.md`, `docs/adr/024-x-datasource-service-boundary.md`, and `docs/adr/032-sync-orchestrator-workflow.md` show real thinking about the ugly shape of X bookmarks rather than generic software-architecture theater.
- Keeping SQLite as the source of truth while using Temporal only for orchestration is exactly the right instinct. `src/temporal/workflows/sync/index.ts` and the surrounding ADRs mostly preserve that line, which keeps failure semantics understandable.
- Routing sync entrypoints through atomic `signalWithStart(...)` on the singleton orchestrator is one of the strongest design choices in the repo. `src/commands/sync/bookmarks/temporal.ts` and `src/temporal/workflows/orchestrator/index.ts` are solving a real race with the right tool.
- The orchestrator/single-run split is excellent. `src/temporal/workflows/orchestrator/index.ts` decides what to run; `src/temporal/workflows/sync/index.ts` owns one execution. That is a clean Temporal seam.
- Durable rate-limit handling is a genuinely good use of Temporal. `src/temporal/workflows/sync/rate-limit.ts` turns upstream API pain into durable sleeps instead of ad hoc timers and retries.
- The codebase has encoded real product scar tissue. Folder-vs-no-folder behavior, backlog drains, delete safety, suspicious terminal pages, and early enrichment all exist because the team learned from the domain.
- The sync engine split is good engineering. `src/lib/sync-engine/sync-engine-core.ts`, `src/lib/sync-runner/*`, and `src/commands/sync-adapter.ts` give you a reusable core instead of separate CLI and workflow snowflakes.
- Test coverage is not decorative. The project has serious behavioral tests around workflows, activities, routing, rate limiting, DB behavior, and queue semantics.

## Everything In Between

These are the areas that are not obviously wrong, but they are expensive and should justify themselves.

- [ ] Contracts, capabilities, and planning are not inherently overbuilt in this repo's stated future. `src/contracts/*` and `src/commands/shared/capability-plan.ts` make sense if this service will sit in a broader multi-service system. The issue is not their existence. The issue is that the codebase now has more than one contract system.
- The DataSource abstraction in `src/sources/*` is strategically reasonable, but it is still early. With one real backend, `src/sources/registry.ts` and `src/sources/selection.ts` are more future-facing than value-dense right now.
- The DB layer is tidy, but not yet compressed. `src/lib/db/client.ts` is a large facade, and the repo split around tweets/bookmarks adds organization without yet removing a lot of handwritten SQL and pass-through code.
- [ ] The API layer in `src/lib/api/*` is understandable and better than a blob, but it is still mostly custom plumbing. It is not yet a strong runtime-validation boundary.
- [ ] The docs are impressive and thoughtful, but some spec docs are ahead of the implementation. That is okay during active architecture work, but the drift is now visible.
- The tests are strong in breadth, but some suites have become architectural warehouses. They still protect value, but the ergonomics are starting to decline.

## WTF

- [ ] There are too many overlapping truth systems for shape, completeness, and contracts. `src/lib/expectations.ts`, `src/lib/assessment.ts`, `src/contracts/entities.ts`, `src/contracts/events.ts`, `src/lib/outbox/event-envelope.ts`, and the docs in `docs/spec/contracts/*` are all circling similar ideas from different angles.
- [ ] `src/temporal/activities/store.ts` is doing the work of several subsystems at once: persistence, enrichment policy application, conversation discovery, quote discovery, retry/backoff policy, and error classification. At 1087 lines, that file is a major reason the repo feels larger than it should.
- [x] The delete model is in an awkward hybrid state. There is inline blocking delete, coordinator-backed blocking delete, and coordinator-backed background delete. `src/temporal/workflows/delete-coordinator/index.ts`, `src/temporal/workflows/sync/page-runner.ts`, and the recent delete-coordinator task docs show a system in transition rather than one clear mental model.
- [ ] The observability contract and implementation are meaningfully out of sync. `docs/spec/observability.md` wants service/trace/operation/entity semantics; `src/lib/logger.ts` is still mostly category/message logging with JSONL sidecar output.
- [ ] Error taxonomy is similarly ahead of runtime reality. `docs/spec/contracts/error-taxonomy.md` describes structured error codes and retryability; large parts of the implementation still classify failures by message text or generic `Error` strings.
- [ ] Workflow-control dispatch currently scales by stringly-typed branching. `src/commands/workflow/control.ts` and `src/commands/workflow/status-command/progress.ts` work, but they linearly accumulate workflow-type-specific conditionals.
- [ ] `src/temporal/workflows/topic-monitor.ts` and `src/temporal/workflows/engagement-tracking.ts` are placeholders that already consume real conceptual surface area. They are exported, startable, controllable, and queryable before they do meaningful business work.
- [ ] Determinism discipline is culturally present, but not yet mechanically enforced. `src/temporal/workflows/enrich/records.ts` still defaults `nowMs` to `Date.now`, which is exactly the sort of thing that should be impossible by convention and tooling, not merely unlikely.

## The Real Size Problem

I do not think the main problem is that the repo has 22K lines in `src`.

I think the real problem is that too many concepts can independently drift:

- contract shape
- runtime validation
- persistence schema
- error semantics
- logging semantics
- workflow ownership
- delete ownership
- enrichment policy semantics

That is the kind of complexity that makes a codebase feel bigger than its line count.

So the critical question is not "can we shrink files?" It is "can we reduce the number of competing abstractions that all partially describe the same system?"

## What John Carmack Would Do

If I had to channel Carmack here, the advice would be blunt:

1. [x] Collapse the delete story into one obvious model.
   - Either the delete coordinator is the Temporal owner of deletes, or sync owns deletes directly.
   - The current hybrid is the highest-complexity part of the system.

2. Pick one schema center of gravity.
   - One runtime-valid source should drive contracts, event envelopes, config validation, and data completeness checks.
   - The team should delete redundant shape systems over time, not add yet another one.

3. Split giant files by operational responsibility, not by arbitrary helper count.
   - `src/temporal/activities/store.ts` is the clearest target.
   - `src/temporal/workflows/enrich/pass.ts`, `src/lib/db/client.ts`, and some test warehouses are next.

4. Make errors and logs either brutally simple or properly structured.
   - Right now they are in the uncanny valley.
   - If this is a real datasource service, then service-grade observability and typed errors should be treated as part of the product.

5. Use Temporal only where it is obviously the simplest correct tool.
   - The orchestrator is a great fit.
   - Rate-limit sleeps are a great fit.
   - Placeholder polling workflows are not yet earning their cost.

6. Replace convention with enforcement for workflow determinism.
   - Workflow-safe time helpers, lint rules, and import discipline should be mechanical.

7. Add a few more runtime-level Temporal tests exactly where the system is most stateful.
   - Long-lived singleton behavior, continue-as-new carry-forward, watch scheduling, and delete completion signaling are higher-value than another layer of mocked unit tests.

8. Keep the service boundary, but reduce ceremony until the second real consumer shows up.
   - The right move is not to rip out contracts.
   - The right move is to keep the hard-won boundaries while trimming speculative scaffolding.

## View On `.project/plans/2026-03-06-typescript-ecosystem-upgrades.md`

That plan is directionally good. My take by category:

### Strong yes

- Schema unification with Valibot or Zod
- DB simplification with Drizzle or at least Kysely
- Proper observability with Pino plus OpenTelemetry
- Better test ergonomics with MSW

These are all leverage moves because they remove custom infrastructure and align multiple truth systems.

### Good, but only after simplification work starts

- `ky` for API ergonomics
- `ts-pattern` for clearer exhaustive branching

Nice wins, but not the highest-order problems.

### High risk / high reward

- Effect

Effect could clean up a lot of handwritten infrastructure, but it is a real paradigm shift. If adopted too early, it risks becoming another abstraction layer on top of existing complexity instead of replacing it.

### Not the first move

- Turso / service scaling infra
- Inngest / Trigger.dev evaluation

Those are strategic questions, but the current repo still has enough local architectural compression available that I would not lead with runtime-platform churn.

## Concrete Recommendations

### P0 - Do next

- Unify delete ownership and choose one runtime story.
- Add `continueAsNew` or an equivalent history-control strategy to `src/temporal/workflows/delete-coordinator/index.ts`.
- Split `src/temporal/activities/store.ts` into separate policy/discovery/persistence modules.
- Choose a schema-validation direction and start consolidating `contracts`, `expectations`, and related envelope logic around it.
- Add targeted runtime tests for orchestrator and delete coordinator lifecycles.

### P1 - Do soon

- Align `src/lib/logger.ts` with `docs/spec/observability.md`, or simplify the spec to match reality.
- Replace stringly error classification with explicit typed error objects at the API/activity boundary.
- Refactor workflow control/status dispatch into a registry/table-driven mapping rather than repeated `if/else if` chains.
- Hide or demote placeholder workflows until they perform real business work.
- Start breaking up giant test files with shared builders/fixtures so the tests stay maintainable.

### P2 - Strategic cleanup

- Adopt Drizzle or Kysely once the DB shape is stable enough to justify the migration cost.
- Simplify source registry/selection until a second real source exists.
- Revisit whether some command surfaces should remain public or be treated as internal operational tools.
- Evaluate Effect only if the team is ready to delete existing infrastructure in the same move.

## Bottom Line

This is not a bloated toy CLI. It is already a real service with a CLI interface, and a lot of the architecture is justified by the problem.

The strongest parts of the codebase are the parts that directly encode the domain: orchestrated sync scheduling, rate-limit durability, delete safety, and workflow-aware testing.

The weakest parts are where the system starts to describe itself multiple times: contracts plus expectations plus assessments plus envelopes plus spec docs plus stringly runtime behavior.

So the path forward is not "make it smaller because small is virtuous."

The path forward is:

- fewer competing abstractions,
- fewer hybrid runtime models,
- clearer ownership,
- stronger schema/error/observability centers of gravity,
- and a ruthless bias toward the minimum number of concepts that can fail.

That is the Carmack move here.
