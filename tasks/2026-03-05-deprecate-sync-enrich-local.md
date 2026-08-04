# Task: Deprecate sync enrich (local-only enrichment)

**Status:** Approved
**Created:** 2026-03-05
**Plan:** .project/plans/2026-03-05-deprecate-sync-enrich-local.md

## Workflow Rules (do not remove)

- Use `/commit` after completing each chunk (not raw git commit)
- Mark completed tasks with `[x]` in this file after each chunk
- Generate chunk boundary report after each chunk
- Stop and wait for review after each chunk
- Do not batch work across chunks

## Chunks

### Chunk 1: Remove command and update source references

- [ ] Delete `src/commands/sync/enrich.ts` (plan: Changes > 1)
- [ ] Remove import and call from `src/commands/sync/register.ts` (plan: Changes > 2)
- [ ] Update hint in `src/commands/sync/bookmarks/local/summary.ts` (plan: Changes > 3)

### Chunk 2: Update documentation

- [ ] Update `README.md` — remove local-only section and examples (plan: Changes > 4)
- [ ] Update `docs/adr/021-decoupled-enrichment.md` references (plan: Changes > 5)
- [ ] Update `docs/adr/020-fields-version-tracking.md` reference (plan: Changes > 5)
- [ ] Add `Removed` entry to `CHANGELOG.md` (plan: Changes > 6)

## Progress Log

### Session 1 - 2026-03-05

- Started task
- Plan: .project/plans/2026-03-05-deprecate-sync-enrich-local.md
- Beginning Chunk 1

## Feedback

## Action Items

## Notes
