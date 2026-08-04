# Plan: Foundation Architecture for Multi-Source Ingestion and Routing

## Date

2026-02-13

## Why this plan exists

The current app is a CLI-first tool with a focused sync workflow. The target direction is broader:

- ingest from multiple data sources
- organize content by intent/context
- route/tag/assign content to topic inboxes/pages
- support richer source-specific intelligence (threads, quote/reply analysis, keyword/topic extraction, contributor discovery, link fetching)

The key design question is where to place these capabilities without overbuilding too early.

## Recommended direction

Keep this project as a **single datasource service** focused on X.

- this repo remains the X API sync engine
- orchestration lives in a separate service layer
- routing/tagging/inbox assignment lives in a separate service layer
- this service sits beside other datasource services under a shared ecosystem

This creates clean ownership boundaries and prevents this codebase from becoming a multi-purpose platform runtime.

## Architectural boundaries

### 1) X datasource service (this repo)

Responsibilities:

- X auth + rate-limit handling
- X-specific sync semantics and limitations handling
- X-specific enrichment capabilities (conversation expansion, quote/reply analysis, link fetch, etc.)
- persistence for raw sync'd data and operational state — no derived metadata (classifications, tags, routing decisions)
- publish standardized outputs via event envelope for downstream services
- capability manifest (what the service can do) and entity schema (what data it produces)

### 2) Orchestration service (separate)

Responsibilities:

- cross-source workflow coordination
- scheduling, retries, and dependency ordering across datasource services
- budget and policy enforcement at ecosystem level

### 3) Routing service (separate)

Responsibilities:

- owns its own `RoutingProfile` (rules, topic assignments, priority, explanation) — completely separate from datasource `GoalProfile`
- rule/profile-driven classification
- topic inbox/page routing
- assignment/tagging decisions
- explanation of routing outcomes
- consumes `RoutableContent` (see below), not source-specific entity types directly

The routing service does not configure datasource execution. If it wants to influence what capabilities a datasource runs, it selects a `GoalProfile` by name — it does not embed routing logic inside one. `GoalProfile` controls *what work happens*; `RoutingProfile` controls *where outputs go*.

### 4) Presentation service(s) (separate)

Responsibilities:

- read models and UI/API surfaces for browsing/sharing
- context-specific views driven by routed outputs

## In-service core vs module rule

Inside this X datasource service, put functionality in shared in-service core only if all are true:

1. required for correctness
2. cross-source reusable
3. needed for governance/consistency

Otherwise, implement as an X capability module.

## Capability pipeline model (inside this service)

Advanced X analysis/enrichment should be pluggable, not hardcoded into base sync:

- conversation expansion
- quote/reply graph extraction
- keyword/topic phrase extraction
- contributor discovery
- link artifact fetching and parsing

Execution is chosen by a service-local `GoalProfile` that defines:

- which capabilities run
- in what order/dependencies
- limits/budgets/cost ceilings

GoalProfile does **not** carry routing intent. Routing, classification, and tagging decisions belong to the routing service (see architectural boundaries). If a downstream service wants to influence which capabilities run, it selects a GoalProfile — it does not embed routing logic inside one.

## Service contract model

This service should expose one stable output contract to upstream/downstream layers.

Internal callers should invoke the same planning contract:

`buildPlan(input, sourceCapabilities, goalProfile) -> { plan } | { errors }`

Use this internally in:

- CLI commands
- worker/runtime entrypoints (defensive validation)

External orchestration/routing services consume outputs from this service, not internal APIs.

## Uniformity and governance requirements

Within this service, enforce:

- idempotency keys
- retry/backoff policy
- rate-limit and budget policy
- standardized error model
- standardized provenance records
- deterministic processing decision records

Across datasource services ecosystem-wide, standardize:

- event envelope schema (initial shape defined for this service in ADR 024)
- entity schema declarations (entity types, fields, completeness levels)
- provenance fields
- error taxonomy and retry hints
- idempotency keys
- observability field set (service, traceId, operation, entityType, entityId, durationMs, error)

## Shared ecosystem concerns

Several concerns will need to be uniform across services as the ecosystem grows. The principle: **define as if the shared package exists** (clean base types, no source-specific assumptions) so extraction is a move, not a rewrite. But don't extract until the trigger condition is met.

### Lifecycle: inline → shared package → central service

| Stage | What it is | When |
| --- | --- | --- |
| **Inline** | Types/patterns defined in this repo | Now (single service) |
| **Shared package** | Extracted to a dependency all services import; compile-time contract | When service #2 starts |
| **Central service** | Runtime registry for discovery, version tracking, compatibility | When 3+ services exist and consumers need runtime discovery |

### Concern catalog

| Concern | What's shared | Current state | Extract trigger |
| --- | --- | --- | --- |
| **Event envelope** | `ServiceEventEnvelope` base type, envelope validation | Defined in ADR 024 for this service | Service #2 needs to emit events |
| **Entity schema** | `EntitySchemaDeclaration` base type, field/completeness declarations | Defined in ADR 024 for this service | Service #2 produces entity types |
| **Capability manifest** | `CapabilityManifest`, `CapabilityDefinition` base types | Defined in ADR 024 for this service | Service #2 declares capabilities |
| **Error taxonomy** | Error codes, retry hint structure, structured error base class | Informal in this service | Service #2 needs same error model |
| **Logging format** | Structured JSON field set, log level conventions | Field set committed in ADR 024 | Service #2 emits logs |
| **Trace propagation** | W3C Trace Context headers, Temporal trace passthrough | Temporal handles it today | HTTP adapter or service #2 |
| **Metrics naming** | Metric name conventions, label cardinality rules, health check shape | Not started | Metrics infrastructure exists |
| **Credentials/auth** | Token storage interface, rotation patterns, OAuth flow base | X-specific in `src/lib/tokens.ts`, `src/lib/oauth.ts` | Service #2 has its own OAuth |
| **Configuration** | Env var conventions, config validation patterns, config shape | In `src/lib/config.ts` | Service #2 needs same patterns |
| **Rate limiting** | Rate limiter interface, backoff strategy types | X-specific in `src/lib/rate-limiter.ts` | Service #2 has rate-limited APIs |
| **Testing utilities** | Envelope validators, mock event generators, schema conformance tests | In this repo's tests | Service #2 needs to validate its events |

### Language-agnostic contracts

Not all services will be TypeScript. The YouTube datasource service is Python. This means the shared contracts must be language-agnostic at the ecosystem level.

**Approach:** Define shared contracts as **JSON Schema first, language bindings second**. The `ServiceEventEnvelope`, entity schemas, capability manifest, and error taxonomy are authored as JSON Schema. Each service generates native types from that source of truth — TypeScript types via codegen for this repo, Python dataclasses/Pydantic models for Python services.

This doesn't change anything being built now (TypeScript interfaces are fine for a single service), but when the shared package is extracted, it should be a schema package (JSON Schema files + validation utilities), not a TypeScript package. Language-specific type generation is each service's responsibility.

### Cross-service interaction model

#### Default: event-driven (prefer this)

The default pattern for cross-service interaction is **emit an event, let a consumer handle it**. The producing service does not need to know who consumes or whether the downstream service is available.

Example: X service discovers a YouTube link during `LinkFetch`. Rather than calling YouTube directly, X emits a `link.discovered` event via the outbox with the video ID, URL, and originating tweet ID. A consumer (orchestration layer, or a simple event router) picks it up and dispatches to the YouTube service. The YouTube service processes it on its own schedule, emits its own `record.synced` event, and downstream consumers (graph, search) join across both services' outputs.

This keeps services fully decoupled — X doesn't import YouTube's client, doesn't handle YouTube's errors, doesn't need YouTube to be running.

#### Exception: synchronous calls (use sparingly)

Direct service-to-service calls are allowed **only when the caller needs the response to continue its current operation**. If the caller can proceed without the response (even with reduced data), use the event-driven path instead.

When a direct call is necessary, these guardrails are mandatory:

| Guardrail | Requirement |
| --- | --- |
| **Timeout** | Every call has an explicit timeout (no unbounded waits) |
| **Retry budget** | Max attempts defined upfront; retries use exponential backoff |
| **Fallback behavior** | Caller defines what happens on failure: skip, queue for later, or fail the operation |
| **Circuit breaker** | Repeated failures trip a circuit breaker; caller falls back without attempting further calls for a cooldown period |
| **Idempotency** | Requests carry an idempotency key so retries don't cause duplicate work |
| **Trace propagation** | Calls propagate trace context for cross-service observability |

#### Graduation criteria

A direct call should graduate to the event-driven/orchestrated path when any of these apply:

- Fan-out: one event triggers calls to multiple downstream services
- Retry complexity: failure handling needs durable state (retries across restarts)
- Ordering: calls must happen in a specific sequence with dependencies
- Budget: the interaction has cost/rate-limit implications that need centralized tracking

#### Concrete example: X → YouTube link enrichment

**Event-driven path (preferred):**

1. X `LinkFetch` extracts YouTube video ID from tweet URL
2. X emits `link.discovered` event: `{ entityType: 'link', data: { sourceEntityType: 'tweet', sourceEntityId: '...', targetService: 'youtube', targetEntityId: 'dQw4w9WgXcQ', url: '...' } }`
3. Event consumer routes to YouTube service
4. YouTube service fetches metadata, stores it, emits `record.synced`
5. X stores the relationship only — "tweet ABC references youtube video XYZ" — via a `link.resolved` event callback or a reconciliation pass

**Direct call path (if X needs metadata to continue):**

1. X `LinkFetch` extracts YouTube video ID
2. X calls YouTube API with guardrails: 5s timeout, 2 retries, fallback = store edge without metadata
3. YouTube returns metadata + artifact reference
4. X stores the relationship only — not the YouTube metadata

**Data ownership:** Each service owns its own entity data. Cross-references are edges, not copies. This preserves the "database is 99% sync'd source data" principle.

### RoutableContent: cross-source schema for classifiers and display

Datasource services produce source-specific entity types (`TweetData`, `VideoData`, etc.). But classifiers, routers, and display consumers should not switch on source-specific shapes — they need a **common content schema** that any datasource can map to.

`RoutableContent` is the lingua franca of the ecosystem for classification and display:

```text
RoutableContent {
  /** Which service produced this */
  source: string;
  /** Entity type within that service */
  sourceEntityType: string;
  /** Unique identifier (service-scoped) */
  sourceEntityId: string;

  /** Primary text content */
  text: string | null;
  /** Content author */
  author: { id: string; name: string | null; handle: string | null } | null;
  /** When the content was created at source */
  createdAt: string | null;
  /** Language */
  lang: string | null;

  /** URLs/links found in content */
  links: string[];
  /** Media attachment types (photo, video, etc.) */
  mediaTypes: string[];

  /** Whether this record is complete or a stub/partial */
  isComplete: boolean;
}
```

Each datasource service is responsible for mapping its entity types to `RoutableContent`. For X: a `TweetData` maps naturally — `text`, `authorId` → author lookup, `createdAt`, `lang`, extracted URLs, media types from associated `MediaData`. For YouTube: `VideoData` maps similarly — `title` → text, channel → author, etc.

The routing service works against `RoutableContent`, not `TweetData` or `VideoData`. This prevents the routing service from accumulating source-specific parsing logic over time.

`RoutableContent` is a shared ecosystem type — it lives in the shared contracts layer alongside the event envelope and entity schema base types. It starts minimal (the shape above) and grows as classifiers need more signals.

### Initial outbox transport: poll-based consumer

Transport mechanism is decided: **poll the outbox table**. This is the simplest approach that satisfies the delivery semantics (section 4c of ADR 024) without requiring new infrastructure.

**How it works:**

1. Consumer process queries for undispatched events: `WHERE dispatched_at IS NULL AND (available_at IS NULL OR available_at <= now()) ORDER BY created_at`
2. Consumer processes each event (classification, routing, display indexing, etc.)
3. On success: set `dispatched_at = now()`
4. On failure: increment `attempts`, set `last_error`, set `available_at` to next retry time (exponential backoff with jitter)
5. After max attempts: set a `dead_letter` flag — event stops retrying, operator investigates

**Replay:** Re-process events by clearing `dispatched_at` for a time range, entity type, or specific IDs. Idempotency keys protect consumers from duplicate side effects.

**Why this over a message bus:** No new infrastructure. The outbox table already exists with `dispatched_at`, `attempts`, `last_error`, and `available_at` columns. A consumer is just a process that polls and marks. When the ecosystem outgrows polling (latency requirements, high throughput, multiple independent consumers), upgrade to a push/bus transport — the delivery semantics don't change, only the pipe.

**Multiple consumers:** Each consumer type (classifier, router, display indexer) tracks its own dispatch state. This can be a separate column per consumer or a `consumer_dispatch` join table. Decided when the second consumer exists.

### What does NOT get shared

- Service-specific API clients (X API, YouTube Data API, RSS parser)
- Service-specific sync semantics (delete-to-access-older is X-only)
- Service-specific enrichment logic
- Concrete entity field definitions (tweet fields are X-specific; the *base type* is shared, the *concrete schema* is not)
- GoalProfile definitions (each service defines its own capabilities and profiles)

### Central service: schema registry / capability catalog

Eventually (Phase 3+), a lightweight central service that:

- aggregates capability manifests from all registered services
- serves entity schema declarations with version history
- validates envelope compatibility (producer schema vs consumer expectations)
- provides a discovery API for orchestration and AI agents

This is not needed until multiple services are producing events and at least one consumer needs runtime discovery. The shared types package covers everything before that point.

## Phased implementation (slow and safe)

### Phase 0: datasource boundary first (no behavior change)

Locked in [ADR 024](/docs/adr/024-x-datasource-service-boundary.md).

- define `CapabilityManifest`, `GoalProfile`, `buildPlan` types
- define `ServiceEventEnvelope` type and event type taxonomy
- define entity schema types for tweet, user, media, bookmark
- define `RoutableContent` type and mapping from X entity types
- define versioning/compatibility rules for envelope and entity schema
- define delivery semantics (at-least-once, idempotent replay, dead letter)
- document existing sync and enrich as capability definitions
- validate that existing CLI and Temporal entrypoints could route through `buildPlan`
- adopt common observability field set in structured log output

### Phase 1: harden this service as a reusable datasource engine

- implement `buildPlan` as a real validation gate in CLI and Temporal entrypoints
- add idempotency keys and provenance fields to outbox events
- enrich outbox payloads to match the event envelope
- expose capability manifest (initially as a static export, queryable in-process)
- keep CLI/operator workflow

### Phase 2: X-specific capability modules

- implement `ConversationExpand`, `LinkFetch`, `TopicExtract`, `ContributorDiscover` as modules
- each capability registers in the manifest with input/output schemas and cost profiles
- `GoalProfile` drives capability selection and ordering

### Phase 3: integrate with external orchestration/routing layers

- orchestration layer invokes this service (via Temporal or HTTP adapter)
- routing layer consumes outbox outputs via event envelope
- capability manifest exposed to external consumers and AI agents
- presentation layer consumes routing outputs

## Initial layout target (for this repo)

- `src/commands/*` (operator UX)
- `src/lib/*` (X sync policies/contracts/utilities)
- `src/sources/*` (X adapter + potential X adjunct sources)
- `src/temporal/*` (local workflow runtime for this datasource service)

Ecosystem-level orchestration/routing live in other services/repos.

## Decision summary

Decided now:

- this repo stays an X datasource sync engine
- orchestration is separate
- routing/inbox assignment is separate
- keep CLI/runtime focus here, expose clean integration contracts outward
- continue modular X-specific capabilities inside this service
- shared concerns are defined inline now, designed for extraction when service #2 starts
- no central service until 3+ services need runtime discovery

Deferred:

- shared schema package extraction as JSON Schema (trigger: second datasource service)
- language-specific type generation from shared schemas (trigger: multi-language ecosystem is real)
- schema registry / capability catalog service (trigger: 3+ services with consumers needing runtime discovery)
- event envelope governance across datasource services — versioning policy, schema evolution ownership (trigger: second datasource service emitting events)
- credentials/secrets management across services (trigger: second service with its own OAuth)
- cross-service call guardrails implementation (trigger: first service-to-service call, e.g. X → YouTube link enrichment)
- exact rule language for routing (owned by routing service)
- UI/API scope and auth model
- multiple consumer dispatch tracking (per-consumer columns vs join table — trigger: second consumer type)

## Progress

### Done

- [ADR 024](/docs/adr/024-x-datasource-service-boundary.md) written — locks datasource-service boundary, capability model, event envelope, entity schema, observability contract, and phased implementation
- Phase 0 contract foundation (completed in code):
  - [x] define `CapabilityManifest`, `GoalProfile`, `buildPlan` types
  - [x] define `ServiceEventEnvelope` type and event type taxonomy
  - [x] define entity schema types for `tweet`, `user`, `media`, `bookmark`
  - [x] define `RoutableContent` type and mapping from X entity types
  - [x] document existing sync and enrich as capability definitions
  - [x] validate that CLI/Temporal entrypoints route through `buildPlan`
  - [ ] adopt common observability field set in structured log output
- Phase 1 hardening (partially completed in code):
  - [x] implement `buildPlan` as a validation gate in CLI/Temporal start entrypoints
  - [x] add idempotency keys and provenance fields to outbox events
  - [x] enrich outbox payloads to match the event envelope
  - [x] expose capability manifest as static in-process contract
  - [x] implement initial poll-based outbox consumer utility
  - [x] keep CLI/operator workflow

### Next

- [ ] adopt common observability field set in structured log output (`service`, `traceId`, `operation`, `entityType`, `entityId`, `durationMs`, `error`)
- [ ] add the first classifier consumer path over `consumeOutboxBatch` + `RoutableContent`
- [ ] add per-consumer dispatch tracking strategy once the second consumer appears
- [ ] begin Phase 2 capability modules (`ConversationExpand`, `LinkFetch`, `TopicExtract`, `ContributorDiscover`)
