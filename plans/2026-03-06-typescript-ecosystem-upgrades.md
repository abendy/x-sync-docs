# TypeScript Ecosystem Upgrades

Evaluation of packages and services that could replace hand-rolled infrastructure, improve type safety, and help scale the codebase.

## Current State

The project is lean on dependencies (12 runtime, 6 dev). Temporal handles workflow orchestration, better-sqlite3 handles persistence, and most other infrastructure — HTTP client, rate limiting, retry logic, error taxonomy, config, validation, outbox events, delete coordination — is hand-written.

## 1. Schema Validation & Data Contracts

**Problem:** Hand-rolled expectations, assessments, contracts, and API response parsing spread across `expectations.ts`, `assessment.ts`, and `contracts/`.

**Options:**

| Package | Size | Style | Notes |
| --- | --- | --- | --- |
| [Zod](https://github.com/colinhacks/zod) | ~57kB | Method chaining | Mature, ubiquitous, zero deps. Largest ecosystem of integrations. |
| [Valibot](https://github.com/fabian-hiller/valibot) | ~5kB (tree-shaken) | Functional, composable | ~10x smaller than Zod. Better for CLI startup time. |
| [ArkType](https://github.com/arktypeio/arktype) | ~30kB | TS-native syntax | Fastest runtime validation. Newer but gaining momentum. |

**Impact:** Eliminates hand-rolled expectations + assessment layer. Single source of truth for types + runtime checks. Validates API responses at the boundary with type narrowing.

**Recommendation:** Valibot for bundle size, Zod for ecosystem breadth.

---

## 2. Database & Query Layer

**Problem:** ~15 hand-written repository files with raw SQL strings, no type-safe query building, runtime migrations via `ALTER TABLE IF NOT EXISTS`.

**Options:**

| Package | Approach | Notes |
| --- | --- | --- |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | Schema-as-code, type-safe SQL | First-class `better-sqlite3` support. `drizzle-kit` generates migration files from schema diffs. Stays close to SQL. |
| [Kysely](https://github.com/kysely-org/kysely) | Type-safe query builder only | Lighter weight. No schema-as-code. Keeps existing repo pattern, just adds safe query construction. |

**Impact:** Type-safe queries replace raw SQL strings. Proper migration files replace runtime `ALTER TABLE` approach. Relational queries simplify tweet-user-media-bookmark joins. Significantly shrinks the repo layer.

**Recommendation:** Drizzle — biggest single reduction in hand-written code with the most type safety gains.

---

## 3. Effect System

**Problem:** Significant hand-rolled infrastructure for error handling, retry/backoff, rate limiting, concurrency control, config, and dependency wiring (registry/selection patterns).

### Full Ecosystem

[Effect](https://github.com/Effect-TS/effect) is an emerging standard for production TypeScript that directly addresses:

- **Typed errors** — Error mapping, error taxonomy, workflow errors become typed channels
- **Retry/rate-limiting** — Built-in `Schedule` and `RateLimiter` replace `rate-limiter.ts` and retry logic
- **Concurrency** — Structured concurrency replaces manual coordination
- **Schema** — `@effect/schema` as Zod alternative within the ecosystem
- **Dependency injection** — `Layer`/`Context` replace manual wiring (registry, selection patterns)
- **Streams** — `Stream` for pagination/cursor loops
- **Config** — Type-safe config loading from env

**Trade-off:** Big paradigm shift, not a drop-in. Temporal workflows stay as-is (own execution model), but activity implementations and lib code would get dramatically cleaner.

### Targeted Alternatives

If Effect is too heavy, adopt individual pieces:

| Package | Replaces | Notes |
| --- | --- | --- |
| [neverthrow](https://github.com/supermacro/neverthrow) | Untyped error handling | Just the `Result<T, E>` type |
| [ts-pattern](https://github.com/gvergnaud/ts-pattern) | switch/if chains | Exhaustive pattern matching for signal handlers, phase dispatch, error mapping |

---

## 4. Observability

**Problem:** Hand-rolled logging. Temporal already supports OpenTelemetry natively but it's not wired up.

**Options:**

| Package | Scope | Notes |
| --- | --- | --- |
| [OpenTelemetry](https://opentelemetry.io/docs/languages/js/) (`@opentelemetry/sdk-node`) | Traces, metrics, logs | Temporal worker has built-in OTel integration. End-to-end traces across workflow-activity-API-DB. Automatic instrumentation for HTTP and SQLite. Export to Jaeger/Grafana/Honeycomb. |
| [Pino](https://github.com/pinojs/pino) | Structured logging | Fastest Node.js logger. JSON by default, child loggers, redaction. Pairs well as OTel log transport. |

**Impact:** Production-grade observability with minimal code. Temporal integration is nearly free since the hooks already exist.

**Recommendation:** Both — Pino as the logger, OTel for distributed tracing.

---

## 5. HTTP & API Client

**Problem:** Hand-rolled auth sessions, rate limit handling, request retry, and response parsing in `src/lib/api/client/`.

**Options:**

| Package | Approach | Notes |
| --- | --- | --- |
| [ky](https://github.com/sindresorhus/ky) | Elegant fetch wrapper | Hooks for before/after request (auth token injection), built-in retry with backoff, timeout handling. Small. |
| [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) | Type-safe fetch from OpenAPI spec | Combined with `openapi-typescript` for codegen, gives auto-complete for every X API endpoint. |

**Impact:** Simplifies the `client/` directory. Auth, retry, and rate-limit become hook/interceptor config rather than custom code.

---

## 6. Testing

**Problem:** API mocking is manual; Temporal integration tests require external server.

**Options:**

| Package | Purpose | Notes |
| --- | --- | --- |
| [MSW](https://github.com/mswjs/msw) (Mock Service Worker) | Network-level API mocking | Intercepts HTTP requests. Tests full X API pipeline (auth-request-parse-rate-limit) without hitting real API. Works with Vitest. |
| [Testcontainers](https://github.com/testcontainers/testcontainers-node) | Dockerized test dependencies | Spin up real Temporal server per test with automatic cleanup. Per-test isolation. |

**Impact:** MSW makes API integration tests reliable and fast. Testcontainers gives proper Temporal integration test isolation.

---

## 7. Services

For scaling beyond local-only execution.

| Service | Replaces/Enables | Notes |
| --- | --- | --- |
| [Turso](https://turso.tech/) | Local-only SQLite | LibSQL (SQLite fork) with cloud replication. Drop-in via `@libsql/client`. Enables multi-device sync or web UI. |
| [Inngest](https://www.inngest.com/) | Self-hosted Temporal (optional) | Serverless workflow engine with TS SDK. Similar step-function model. Worth evaluating if Temporal infra feels heavy. |
| [Trigger.dev](https://trigger.dev/) | Self-hosted Temporal (optional) | Background jobs as code. TypeScript-native. Serverless. |
| [Upstash](https://upstash.com/) | Local rate limiting | Serverless Redis. `@upstash/ratelimit` for distributed rate limiting across multiple workers. |

---

## 8. Small Utilities

High-impact, low-risk additions.

| Package | Replaces | Why |
| --- | --- | --- |
| [ts-pattern](https://github.com/gvergnaud/ts-pattern) | switch/if chains | Exhaustive pattern matching for signal handlers, phase dispatch, error mapping |
| [p-queue](https://github.com/sindresorhus/p-queue) | Hand-rolled concurrency | Promise queue with concurrency control, useful in activities |
| [nanoid](https://github.com/ai/nanoid) | `crypto.randomUUID()` | Shorter, URL-safe IDs for ref IDs |
| [conf](https://github.com/sindresorhus/conf) | `config.ts` | Schema-validated, persistent config with dot-path access |
| [date-fns](https://github.com/date-fns/date-fns) or [Tempo](https://github.com/formkit/tempo) | Manual date math | Date formatting for TUI/logs |

---

## Priority Ranking

Ordered by impact-to-effort ratio:

| Priority | Package | Effort | Impact |
| --- | --- | --- | --- |
| 1 | **Drizzle ORM** | Medium | High — type-safe DB, proper migrations, shrinks ~15 repo files |
| 2 | **Zod/Valibot** | Low-Medium | High — unifies validation/contracts/expectations |
| 3 | **OpenTelemetry** | Low | High — production observability, Temporal integration nearly free |
| 4 | **ts-pattern** | Low | Medium — readability win across signal/phase/error dispatch |
| 5 | **MSW** | Low | Medium — reliable, fast API integration tests |
| 6 | **Pino** | Low | Medium — structured logging, replaces hand-rolled logger |
| 7 | **ky** | Medium | Medium — simplifies API client layer |
| 8 | **Effect** | High | Very High — replaces most hand-rolled infra, but paradigm shift |
| 9 | **Turso** | Medium | Medium — enables multi-device/cloud scenarios |

## Decision Log

| Date | Decision | Notes |
| --- | --- | --- |
| | | |
