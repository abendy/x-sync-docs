# Litestream → rsync.net — continuous DB replication

Date: 2026-08-05
Repository: x-bookmarks-scraper (infra only — no repo code changes)
Status: Ready — needs owner's rsync.net username + SSH key choice, and execution on the Mini

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

4. Start + persist: `brew services start litestream` (launchd-managed, matches the runtime-substrate convention).
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
