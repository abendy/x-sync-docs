# Litestream → rsync.net — continuous DB replication

Date: 2026-08-05
Repository: x-bookmarks-scraper (infra only — no repo code changes)
Status: Ready — needs owner's rsync.net username + SSH key choice, and execution on the Mini

## Why now — archive-loss risk model (owner-raised 2026-08-05)

Drain syncs delete unrecoverable live X data; the local SQLite file is then the **only** copy, and it lives inside an active development checkout. Verified loss vectors, worst first:

1. **Worktree phantom-DB drain (one command away today).** `DEFAULT_DB_PATH = './data/bookmarks.db'` is CWD-relative and `BookmarksDb` silently creates a fresh empty DB if none exists (src/lib/db/client.ts:418, 47–53). An agent running `pnpm dev sync <folder>` from a worktree drains real X bookmarks into a throwaway DB that vanishes with the worktree.
2. **`git clean -fdx` wipes archive + backups together** — `data/bookmarks.db` and `data/backups/` are both gitignored, so one routine command deletes both.
3. Dev-branch bugs corrupting rows or botching runtime migrations against the real file.
4. Agent/user error: tests or scripts pointed at the real DB, restore-over-live, plain `rm`, or simply forgetting the dev copy IS production.
5. Single-machine disk loss.

## Layered mitigations

- **Layer 0 — off-tree snapshot (DONE 2026-08-05):** verified `sqlite3 .backup` copy at `~/Backups/x-bookmarks/bookmarks-20260805-pre-litestream.db` (integrity ok, 12,628 bookmarks / 15,500 tweets). Refresh manually before risky work until Litestream is live.
- **Layer 1 — this plan (Litestream → rsync.net):** continuous off-machine replication + 30-day PITR. Covers vectors 2–5 once running. **Execute before any further delete-enabled testing.**
- **Layer 2 — proposed: canonical DB out of the repo tree.** Honor an env override (e.g. `X_BOOKMARKS_DB`) in `getDb`'s default; canonical archive moves to `~/dada.stream/data/x-sync/bookmarks.db` per the runtime-substrate convention; `./data/bookmarks.db` in any checkout becomes disposable dev scratch. Kills vectors 2 and most of 4 structurally.
- **Layer 3 — proposed: delete-authority invariant.** Delete-enabled sync runs only against a DB explicitly marked as the canonical archive (one-time marker row in `sync_state`, e.g. `archive_role=primary`, set by a new `pnpm dev archive mark` command). Any unmarked DB — worktree-fresh, scratch, restored copy — auto-degrades every sync to `--no-delete` with a loud warning. Kills vector 1 dead: X-side deletes become impossible against a database that isn't the durable archive.
- **Layer 4 — agent guardrails in CLAUDE.md:** the archive is sole-copy production data; never `git clean -fdx` here; tests use temp DBs only; delete-enabled sync only from the canonical checkout. Soft but cheap; agents read it.

Layers 2+3 are small features (pause already suspended); each is independently shippable.

## Summary

Replace "backup exists only when someone remembers to run `pnpm dev backup`" with continuous streaming replication of `data/bookmarks.db` from the Mini (single writer, per D5) to rsync.net over SFTP, giving point-in-time restore. The MBP never replicates — it restores fresh copies on demand. The manual `pnpm dev backup` command stays: the folder-sync-report skill's safety rule 3 uses it as a pre-drain snapshot, which remains valuable as an instant local rollback point independent of network.

Verified: SFTP is a first-class replica type in current Litestream (v0.5.x) with SSH-key auth — https://litestream.io/guides/sftp/. rsync.net is native SFTP storage, so no adapters.

## Topology

- **Mini** (always-on primary, runs worker + Temporal): `litestream replicate` as a service. Only machine that writes the DB, only machine that replicates.
- **rsync.net**: replica home at `litestream/x-bookmarks/bookmarks.db` under the account root.
- **MBP**: restore-only. Never run `replicate` here against the same replica path — two replicators on one lineage corrupt the generation history.

## Mini setup (run there, or via `ssh mini`)

1. Install: `brew install litestream`
2. SSH key: reuse or create a dedicated key (`ssh-keygen -t ed25519 -f ~/.ssh/rsync-net-litestream`), add the pubkey to rsync.net (`ssh <user>@<user>.rsync.net` — their web console or authorized_keys append). Test: `sftp <user>@<user>.rsync.net`.
3. Config at `/opt/homebrew/etc/litestream.yml` (Homebrew's service default on Apple Silicon):

```yaml
dbs:
  - path: /Users/abendy/projects/x-bookmarks-scraper/data/bookmarks.db
    replicas:
      - type: sftp
        host: <user>.rsync.net:22
        user: <user>
        key-path: /Users/abendy/.ssh/rsync-net-litestream
        path: litestream/x-bookmarks/bookmarks.db
        retention: 720h        # 30 days of point-in-time history
        snapshot-interval: 24h # daily full snapshot bounds restore time
```

4. Start + persist — **not** `brew services` (neither the core formula nor the official tap ships a service definition; it errors with "formula not implemented plist", verified 2026-08-05). Write a launchd job instead:

   `~/Library/LaunchAgents/io.litestream.replicate.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>io.litestream.replicate</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/litestream</string>
       <string>replicate</string>
       <string>-config</string>
       <string>/opt/homebrew/etc/litestream.yml</string>
     </array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/opt/homebrew/var/log/litestream.log</string>
     <key>StandardErrorPath</key><string>/opt/homebrew/var/log/litestream.log</string>
   </dict>
   </plist>
   ```

   ```bash
   mkdir -p /opt/homebrew/var/log
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.litestream.replicate.plist
   launchctl print gui/$(id -u)/io.litestream.replicate | head -5   # state = running
   ```

   After config edits: `launchctl kickstart -k gui/$(id -u)/io.litestream.replicate`. Remove with `launchctl bootout gui/$(id -u)/io.litestream.replicate`.

   LaunchAgent assumes the Mini auto-logs into your account (gui domain). If it runs headless with no login session, use a LaunchDaemon instead: same plist plus `<key>UserName</key><string>abendy</string>`, placed at `/Library/LaunchDaemons/` via sudo, bootstrapped with `sudo launchctl bootstrap system /Library/LaunchDaemons/io.litestream.replicate.plist`.
5. Verify:
   - `litestream databases` lists the DB; `litestream snapshots <db-path>` shows a snapshot after a minute.
   - Fire drill: `litestream restore -o /tmp/verify.db /Users/abendy/projects/x-bookmarks-scraper/data/bookmarks.db && sqlite3 /tmp/verify.db "PRAGMA integrity_check; SELECT COUNT(*) FROM bookmarks;"`
   - Worker compatibility: run a small folder sync while replicating; confirm no `database is locked` errors in worker logs (Litestream takes over checkpointing; better-sqlite3 needs no changes).

## MBP usage (restore-only)

```bash
brew install litestream
litestream restore -o ~/projects/x-bookmarks-scraper/data/bookmarks.db \
  "sftp://<user>@<user>.rsync.net/litestream/x-bookmarks/bookmarks.db"
```

Overwrites the local copy with the latest replicated state (or `-timestamp` for point-in-time). Local copy is then independent — safe to query, import into, or hack on; it is NOT written back. Anything that must persist canonically (imports included) runs against the Mini's DB.

## Config ownership

The yml + launchd service are machine config → dotfiles repo (`~/projects/dotfiles`), which is the established source of truth for machine setup. Nothing lands in the scraper repo; this plan documents the decision.

## Caveats

- Single lineage: one `replicate` process, ever. MBP restores only.
- Litestream replicates committed state continuously — a bad write replicates too; that is what `-timestamp` restore and the 30-day retention are for.
- The existing `data/backups/` snapshots and `pnpm dev backup` are unaffected and still recommended before delete-enabled runs.

## Acceptance

- [ ] `litestream snapshots` shows an rsync.net snapshot from the Mini
- [ ] Fire-drill restore passes `PRAGMA integrity_check` with plausible row counts
- [ ] Worker sync runs clean while replication is active
- [ ] MBP one-liner restore documented in dotfiles and tested once

## Handoff prompt — safety layers 2+3 (runs on the Mini)

The Mini has no `.env`, no X auth, and no real database — which is exactly why it is the safe place for this work. Live verification happens later on the MBP or after the DB + auth move to the Mini.

```markdown
Work in the x-bookmarks-scraper repo (github.com:abendy/x-bookmarks-scraper, branch develop).
If not present locally, clone it; then create a feature branch/worktree and run pnpm install.
First read: CLAUDE.md, .claude/ts-style.md, .claude/ts-testing.md, .claude/ts-packages.md.

Do not remove, inline, or reshape existing code to dodge lint limits. Do not make unrelated changes.

## Environment facts (this machine)

No .env, no X auth, no real bookmarks database — intentional. NEVER run `pnpm dev auth`, any
sync against X, Temporal servers/workers, or create databases outside temp/test directories.
All verification is offline: unit tests with temp DBs, plus the auth-free `init` command.

## Task — two archive-safety features

Context: drain syncs delete unrecoverable live X data; the local SQLite file is the only archive,
and today it lives at a CWD-relative default path that silently creates a fresh empty DB
(src/lib/db/client.ts:418 DEFAULT_DB_PATH, 47–53 silent create). A sync run from a worktree can
therefore drain X into a throwaway database. These two layers close that.

### Layer 2 — canonical DB path via environment

- Honor `X_BOOKMARKS_DB` (absolute path, or CWD-relative as today when unset) as the default DB
  path. Resolve it in one place following the existing env-helper pattern in src/lib/config.ts,
  consumed by `getDb()`'s default (src/lib/db/client.ts:422). Explicit-path callers
  (src/commands/init.ts:31, src/commands/backup.ts:33) keep their behavior; their defaults should
  flow through the same resolution.
- `pnpm dev status` output gains one line: the resolved DB path in use and its archive role
  (see Layer 3).

### Layer 3 — delete-authority marker

- New commands in src/commands/ (register in src/cli/program.ts): `archive mark` sets
  `archive_role=primary` in the sync_state KV (MetaRepo setSyncState/getSyncState,
  src/lib/db/meta-repo.ts:20); `archive status` prints the resolved DB path + role.
- One shared helper in src/lib/ (e.g. `delete-authority.ts`): given a BookmarksDb, answers
  whether X-side deletes are permitted (marker present).
- Gate BOTH delete execution paths with it:
  1. Local engine: at delete/backlog phase entry (src/lib/sync-engine/engine/phases/backlog.ts
     and the process/delete phase; InlineDeleteCoordinator entry at
     src/lib/delete-coordinator/coordinator.ts). If deletes were requested but the DB is not
     marked primary, degrade the run to no-delete (existing noDelete option,
     src/lib/sync-engine/types.ts:55) and log one loud, unmissable warning.
  2. Temporal activities: in src/temporal/activities/delete.ts, refuse with a non-retryable
     ApplicationFailure carrying the same message. Do NOT modify anything under
     src/temporal/workflows/** — workflow code is deterministic and off-limits.
- Semantics: absence of the marker NEVER blocks archiving/store/enrich — only X-side deletes.

## Hard constraints

- Allowed writes: src/commands/** (archive command, status line), src/cli/program.ts
  (registration — append, don't reorder), src/lib/config.ts (env helper),
  src/lib/db/client.ts (default-path resolution only), src/lib/db/meta-repo.ts (only if a
  KV accessor is genuinely missing), src/lib/delete-authority.ts (new),
  src/lib/sync-engine/** and src/lib/delete-coordinator/** (gating only),
  src/temporal/activities/delete.ts (gating only), src/types/**, tests/**.
- No new dependencies. No changes under src/temporal/workflows/**.
- Another worker is implementing an `import` command on a parallel branch touching
  src/cli/program.ts and bookmark repos — rebase onto latest develop before finalizing and keep
  your program.ts change append-only to minimize conflicts.

## Verification (all offline)

1. pnpm lint && pnpm typecheck && pnpm test
2. New tests: env override resolution (set/unset X_BOOKMARKS_DB); archive mark/status round-trip;
   local-engine degrade-to-noDelete when unmarked + warning emitted; marked DB permits deletes;
   temporal delete activity refuses non-retryably when unmarked (see existing activity tests for
   harness patterns); store/enrich paths unaffected by absence of marker. Temp DBs per test
   (tests/db.test.ts pattern).
3. Smoke without auth: X_BOOKMARKS_DB=/tmp/layers-smoke.db pnpm dev init && pnpm dev archive
   status (expect unmarked) && pnpm dev archive mark && pnpm dev archive status (expect primary).
   Delete /tmp/layers-smoke.db* afterward.

## Commit

Stage files by name. Subject-only conventional message:
feat(safety): add canonical DB env override and delete-authority marker
No body, no trailers. Do NOT push.

## Report back

Commit SHA, files touched, test count added, exact gating points chosen, and any spec deviation
with one-line justification. If blocked, stop and report instead of improvising.
```

### Deferred live verification (owner, later on the MBP or post-transfer Mini)

- [ ] Real folder drain on the marked archive behaves exactly as before
- [ ] Same sync from an unmarked scratch DB degrades to no-delete with the warning
- [ ] `pnpm dev status` shows the resolved path + role on both machines
