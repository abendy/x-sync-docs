# Project Workspace Index

This folder holds in-progress task plans, reviews, ideas, and internal issue notes.
Files here are intentionally not committed.

## Plans & Tasks

| Date | Type | File | Description | Status |
| --- | --- | --- | --- | --- |
| 2026-03-07 | Implementation | [sync-orchestrator-delete-coordinator-live-test-checklist](./tasks/2026-03-07-sync-orchestrator-delete-coordinator-live-test-checklist.md) | Live test checklist for sync orchestrator + delete coordinator behavior | 🟡 In Progress |
| 2026-03-05 | Plan | [delete-coordinator-workflow](./plans/2026-03-05-delete-coordinator-workflow.md) | Shared delete coordinator with blocking/background modes for folder and no-folder sync | 🟡 In Progress |
| 2026-02-20 | Plan | [thread-aware-enrichment-get-posts-by-ids-plan](./plans/2026-02-20-thread-aware-enrichment-get-posts-by-ids-plan.md) | Thread-aware enrichment plan with batch hydration and bounded context expansion | Implemented, partial |
| 2026-03-07 | Task | [carmack-project-review](./tasks/2026-03-07-carmack-project-review.md) | Candid TypeScript + Temporal architecture review with simplification priorities | 🟢 Approved |
| 2026-03-07 | Task | [carmack-code-review](./tasks/2026-03-07-carmack-code-review.md) | Carmack-Style Code Review: x-bookmarks-scraper | 🟢 Approved |
| 2026-03-05 | Implementation | [deprecate-sync-enrich-local](./tasks/2026-03-05-deprecate-sync-enrich-local.md) | Remove local-only `sync enrich` in favor of workflow | 🟢 Approved |
| 2026-03-05 | Plan | [deprecate-sync-enrich-local](./plans/2026-03-05-deprecate-sync-enrich-local.md) | Remove local-only `sync enrich` in favor of workflow | 🟢 Approved |
| 2026-02-27 | Plan | [deprecate-sync-subcommands-and-move-state-to-workflow](./plans/2026-02-27-deprecate-sync-subcommands-and-move-state-to-workflow.md) | Deprecate sync subcommands, move state to workflow | 🟢 Approved |
| 2026-02-19 | Plan | [sync-orchestrator-workflow](./plans/2026-02-19-sync-orchestrator-workflow.md) | Singleton orchestrator to serialize syncs with priority queue and watch mode | 🟢 Approved |
| 2026-03-06 | Plan | [typescript-ecosystem-upgrades](./plans/2026-03-06-typescript-ecosystem-upgrades.md) | Evaluate packages and services to replace hand-rolled infra and improve type safety | 🔵 Planned |
| 2026-03-04 | Plan | [video-download-workflow](./plans/2026-03-04-video-download-workflow.md) | Video download workflow for native X videos and YouTube URLs | 🔵 Planned |
| 2026-02-13 | Plan | [foundation-architecture-core-runtimes-capabilities](./plans/2026-02-13-foundation-architecture-core-runtimes-capabilities.md) ; [docs/adr/024-x-datasource-service-boundary.md](../docs/adr/024-x-datasource-service-boundary.md) ; [docs/spec/README.md](../docs/spec/README.md) ; [docs/spec/INDEX.md](../docs/spec/INDEX.md) | Foundation architecture for multi-source ingestion and routing — **needs reconciliation with dada.stream** (`~/projects/dada.stream/platform/contracts/`) before execution; also the vehicle to migrate this repo into `dada.stream/components/x-sync/` | 🔵 Planned |
| 2026-02-22 | Plan | [enrichment-intents-policy-queue-plan](./plans/2026-02-22-enrichment-intents-policy-queue-plan.md) | Intent-driven queue + lane runtime expansion plan (parked for lean release) | 🔴 Deferred |
| 2026-01-15 | Plan | [convex-integration-assessment](./plans/2026-01-15-convex-integration-assessment.md) | Convex as Temporal complement | 🔴 Deferred |
| 2026-03-07 | Implementation | [delete-coordinator-full-ownership](./tasks/2026-03-07-delete-coordinator-full-ownership.md) | Collapse all Temporal delete execution into the coordinator (full ownership) | Complete |
| 2026-03-06 | Implementation | [sync-orchestrator-watch-priority-follow-up](./tasks/2026-03-06-sync-orchestrator-watch-priority-follow-up.md) | Follow-up command model for `--next`, repeat-by-shape watch, and self-starting orchestration | Complete |
| 2026-03-06 | Implementation | [sync-orchestrator-workflow](./tasks/2026-03-06-sync-orchestrator-workflow.md) | Singleton orchestrator to serialize syncs with priority queue and watch mode | Complete |
| 2026-03-06 | Implementation | [delete-coordinator-blocking-background-follow-up](./tasks/2026-03-06-delete-coordinator-blocking-background-follow-up.md) | First-pass Stage 3 runtime work for real blocking/background delete behavior | Complete |
| 2026-03-06 | Implementation | [delete-coordinator-workflow](./tasks/2026-03-06-delete-coordinator-workflow.md) | Shared delete coordinator interface (Stage 2) | Complete |
| 2026-03-05 | Plan | [unified-conversation-quote-model-policy-display-plan](./plans/2026-03-05-unified-conversation-quote-model-policy-display-plan.md) | Unified plan for conversation+quote model, enrichment policy, and `browse --tweet` display | Complete |
| 2026-03-05 | Plan | [no-folder-page-by-page-fetch-store](./plans/2026-03-05-no-folder-page-by-page-fetch-store.md) | Move no-folder sync to page-by-page fetch/store with delete-reveal restart when cursor pagination ends early | Complete |
| 2026-03-05 | Implementation | [no-folders-no-delete-sync-mode](./tasks/2026-03-05-no-folders-no-delete-sync-mode.md) | Test `--no-folders` + `--no-delete` sync mode at scale | Complete |
| 2026-03-04 | Plan | [no-folders-no-delete-sync-mode](./plans/2026-03-04-no-folders-no-delete-sync-mode.md) | Test plan for `--no-folders` + `--no-delete` sync mode | Complete |
| 2026-03-04 | Plan | [early-stop-terminal-short-page-folder-drain](./plans/2026-03-04-early-stop-terminal-short-page-folder-drain.md) | Early stop on terminal short page in folder drain sync | Complete |
| 2026-03-04 | Plan | [require-folder-arg-in-workflow-start-sync](./plans/2026-03-04-require-folder-arg-in-workflow-start-sync.md) | Require --folder in workflow start sync (matching CLI) | Complete |
| 2026-03-04 | Plan | [add-folder-name-resolution-to-sync-commands](./plans/2026-03-04-add-folder-name-resolution-to-sync-commands.md) | Resolve folder names to IDs in sync commands | Complete |
| 2026-03-04 | Plan | [manual-enhance-targeted-policy-plan](./plans/2026-03-04-manual-enhance-targeted-policy-plan.md) | Reframe manual enrich as tweet-targeted enhance flow with policy application | Complete |
| 2026-03-04 | Implementation | [manual-enhance-targeted-policy](./tasks/2026-03-04-manual-enhance-targeted-policy.md) | Manual enrich as targeted policy execution | Complete |
| 2026-02-20 | Plan | [media-download-retries-404-infinitely](./plans/2026-02-20-media-download-retries-404-infinitely.md) | Fix infinite 404 retries in media download workflow | Complete |
| 2026-02-19 | Task | [rate-limit-bypass-temporal-delete](./tasks/2026-02-19-rate-limit-bypass-temporal-delete.md) | Fix rate limit bypass during Temporal delete phase | Complete |
| 2026-02-19 | Task | [add-continueasnew-to-media-download-workflow](./tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md) | Add continueAsNew to prevent unbounded workflow history | Complete |
| 2026-02-19 | Task | [review-findings-deduplicate-patterns](./tasks/2026-02-19-review-findings-deduplicate-patterns.md) | Address review findings: separate client lifecycle, output gate, tests | Complete |
| 2026-02-19 | Task | [deduplicate-sync-workflow-command-patterns](./tasks/2026-02-19-deduplicate-sync-workflow-command-patterns.md) | Deduplicate sync/workflow command patterns | Complete |
| 2026-02-18 | Task | [media-download-workflow](./tasks/2026-02-18-media-download-workflow.md) | Media Download Workflow | Complete |
| 2026-02-15 | Task | [codebase-decomposition-review](./tasks/2026-02-15-codebase-decomposition-review.md) | Review codebase decomposition for multi-service architecture | Complete |
| 2026-02-14 | Task | [drain-by-default-folder-sync](./tasks/2026-02-14-drain-by-default-folder-sync.md) | Folder sync drains by default; `--pages` becomes safety cap | Complete |
| 2026-02-14 | Task | [enrichment-runs-sequentially-instead-of-concurrently-with-deletes](./tasks/2026-02-14-enrichment-runs-sequentially-instead-of-concurrently-with-deletes.md) | Enrichment runs sequentially instead of concurrently with deletes | Complete |
| 2026-02-13 | Task | [start-enrichment-before-delete](./tasks/2026-02-13-start-enrichment-before-delete.md) | Start enrichment before delete phase via `onBeforeProcess` callback | Complete |
| 2026-02-13 | Task | [delete-phase-and-rate-limit-logging](./tasks/2026-02-13-delete-phase-and-rate-limit-logging.md) | Improve delete-phase and rate-limit logging | Complete |
| 2026-02-13 | Task | [pages-option-folder-sync](./tasks/2026-02-13-pages-option-folder-sync.md) | Add `--pages` for multi-cycle folder sync | Complete |
| 2026-02-13 | Task | [limitation-canary](./tasks/2026-02-13-limitation-canary.md) | Passive runtime detection for resolved API limitations | Complete |
| 2026-02-13 | Task | [enable-local-stub-enrichment](./tasks/2026-02-13-enable-local-stub-enrichment.md) | Enable local stub enrichment in `sync enrich` | Complete |
| 2026-02-10 | Task | [decouple-enrichment-from-sync](./tasks/2026-02-10-decouple-enrichment-from-sync.md) | Decouple enrichment from sync engine | Complete |
| 2026-02-09 | Task | [restructure-readme-temporal](./tasks/2026-02-09-restructure-readme-temporal.md) | Restructure README with Temporal commands | Complete |
| 2026-02-08 | Task | [api-field-coverage](./tasks/2026-02-08-api-field-coverage.md) | Expand API field coverage for live tracking | Complete |
| 2026-02-08 | Task | [re-enrichment-field-versioning](./tasks/2026-02-08-re-enrichment-field-versioning.md) | Re-enrichment workflow with field versioning | Complete |
| 2026-02-07 | Task | [track-unavailable-tweets](./tasks/2026-02-07-track-unavailable-tweets.md) | Track unavailable tweets during enrichment | Complete |
| 2026-02-07 | Task | [drain-mode-safety-gate](./tasks/2026-02-07-drain-mode-safety-gate.md) | Drain mode & enrich-before-delete safety gate | Complete |
| 2026-02-07 | Task | [remove-tier-rate-limiting](./tasks/2026-02-07-remove-tier-rate-limiting.md) | Remove tier-based rate limiting (Phase 2) | Complete |
| 2026-02-07 | Task | [interleave-enrich-delete](./tasks/2026-02-07-interleave-enrich-delete.md) | Merge enrich + delete into per-item loop | Complete |
| 2026-02-03 | Task | [x-api-pricing-assessment](./tasks/2026-02-03-x-api-pricing-assessment.md) | X API pay-per-usage migration & refactoring | Complete |
| 2026-01-20 | Task | [code-review-action-items](./tasks/2026-01-20-code-review-action-items.md) | Prioritized items from code review | Complete |
| 2026-01-15 | Task | [code-review](./tasks/2026-01-15-code-review.md) | Structure, cleanliness, expandability review | Complete |
| 2026-01-13 | Task | [temporal-integration](./tasks/2026-01-13-temporal-integration.md) | Temporal as default execution path | Complete |
| 2026-01-10 | Task | [initial-implementation-plan](./tasks/2026-01-10-initial-implementation-plan.md) | Original project implementation plan | Complete |

## Ideas

| File | Description |
| --- | --- |
| [bird-integration](./ideas/bird-integration.md) | Bird as alternative data source for unlimited API access |
| [goap-enrichment-planner](./ideas/goap-enrichment-planner.md) | GOAP-based enrichment planning brainstorm |

## Issues (Internal Notes)

| File | Description |
| --- | --- |
| [folder-endpoint-limitation](../docs/issues/folder-endpoint-limitation.md) | Folder endpoint missing query param support (no expansions/fields) |
| [folder-pagination](../docs/issues/folder-pagination.md) | Folder listing and folder bookmarks lack proper pagination |
| [multi-folder-bookmarks](../docs/issues/multi-folder-bookmarks.md) | Delete endpoint removes bookmark globally, not per-folder |
| [all-bookmarks-pagination-inconsistency](../docs/issues/all-bookmarks-pagination-inconsistency.md) | All-bookmarks endpoint can return a false terminal page at higher request sizes |
