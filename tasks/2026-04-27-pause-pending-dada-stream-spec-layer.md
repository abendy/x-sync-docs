# Pause: pending dada.stream spec layer

## Date

2026-04-27

## Status

Active pause. New feature work on this scraper is paused while the dada.stream spec layer is consolidated. Resumes when the consolidation index is sufficiently complete that this scraper can be reshaped against it cleanly and lifted into the dada.stream monorepo as `components/x-sync/`.

## Context

This scraper is the **current and authoritative x-sync codebase** for the dada.stream ecosystem (`~/projects/dada.stream/`). It will be migrated to `components/x-sync/` in dada.stream's Phase 4 component-spec round per the consolidation index.

Before that migration is useful, the scraper has to be **reconciled against the new dada.stream spec layer** that landed on 2026-04-26 — content envelope shape, lens model, status-flavors model, routing model, and the contract-discipline ADRs. Building more on top of the current shape extends the gap.

## Reconciliation work (when pause lifts)

The scraper's existing thinking — `.project/plans/`, the `docs/adr/` ADRs, the contracts/manifest layer in `src/contracts/` — needs re-evaluation against the dada.stream spec layer:

1. **Conform envelope output** to `~/projects/dada.stream/platform/domains/content-model.md` (as amended 2026-04-26): single `tags: TagApplication[]` field replacing the prior split between tags and topic assignments; envelope-level `state` removed (intrinsic state moves to a per-(user, content) layer; context-bound state to lenses).
2. **Service manifest** conforms to `~/projects/dada.stream/platform/contracts/service-manifest.md`.
3. **Apply contract-trust principles** from `~/projects/dada.stream/platform/architecture/decisions/004-contract-trust-validation-model.md`: edge service owns data quality internally; emits canonical envelopes; downstream trusts.
4. **Apply existing in-repo code-review findings** as the local punch list for the cleanup pass:
   - `2026-03-07-carmack-code-review.md` — over-architecture, dead contracts layer, repo-pattern overhead, dead code
   - `2026-03-07-carmack-project-review.md` — broader architecture review
   - `2026-02-15-codebase-decomposition-review.md` — earlier decomposition pass
5. **Outbox / event emission** model conforms to `~/projects/dada.stream/platform/contracts/event-types.md`.
6. **Pre-existing reconciliation flag** on the foundation-architecture plan (`.project/plans/2026-02-13-foundation-architecture-core-runtimes-capabilities.md`) — that plan can either be retired (its responsibilities shift into the dada.stream spec layer + this scraper as `x-sync`) or rewritten as a migration plan; decide when reconciliation begins.

## Cross-references

- `~/projects/dada.stream/.project/plans/2026-04-26-consolidation-index.md` — the canonical merge index. Phase 4 lists `components/x-sync/` as a target landing for this codebase; Phase 5 lists the reconciliation as item #33 and the monorepo migration as item #34.
- `~/projects/dada.stream/platform/architecture/decisions/` — ADRs that constrain reconciliation (esp. 002, 004, 008, 009, 010, 011).
- `~/projects/dada.stream/platform/domains/content-model.md` — envelope shape this scraper must produce.
- `~/projects/dada.stream/platform/contracts/` — manifest, event types, API conventions this scraper must conform to.

## What "pause" means in practice

- **No new feature plans.** Existing in-progress work (sync orchestrator + delete coordinator live test, etc.) continues to running stability where partway-done; new initiatives wait.
- **Bug fixes and operational maintenance continue** — the scraper is in active use.
- **No new ADRs in this repo** for decisions that the dada.stream spec layer is about to make. If a question arises that touches contracts or envelopes, it goes to the dada.stream consolidation index, not into a local ADR.
- **No deeper investment in the contracts/manifest layer** — it will be replaced by conformance to the dada.stream spec when reconciliation begins.

## Lift trigger

Pause lifts when the dada.stream consolidation index has Phase 1 (data-model spine) and Phase 2 (cross-cutting posture) substantially complete. At that point the scraper has a stable target to conform against.
