# Hub Journal backup, restore and rollback

The Hub Journal is operational state, not disposable cache. It contains wallet receipt reconciliation, bridge/launch observations, portfolio history, paper strategy state and operator/audit records.

## Backup

A backup may be created while the Hub is running. The CLI uses SQLite's online backup API so committed WAL state is included consistently.

Development:

```bash
npm run hub:journal -- backup --db ./data/hood-traders.db
```

Built runtime:

```bash
node dist/hub-journal.js backup --db /app/data/hood-traders.db
```

By default backups are written under a sibling `backups/` directory. You may choose an explicit destination:

```bash
node dist/hub-journal.js backup \
  --db /app/data/hood-traders.db \
  --out /app/data/backups/pre-deploy.db
```

Each backup gets a JSON manifest containing its size, SHA-256 checksum and table inventory.

## Verify

Verify the live Journal:

```bash
node dist/hub-journal.js verify --db /app/data/hood-traders.db
```

Verify a backup and its manifest:

```bash
node dist/hub-journal.js verify-backup \
  --from /app/data/backups/pre-deploy.db
```

Verification requires SQLite `quick_check` and `integrity_check` to return `ok`, and requires the Hub's core tables to be present.

## Restore

Restore is intentionally offline-only. The CLI will refuse to restore without an explicit confirmation flag.

1. Stop the Hub process/container.
2. Verify the selected backup.
3. Restore it.
4. Restart the Hub.
5. Check `GET /api/health` and inspect Activity/receipt reconciliation before accepting the deployment.

Example:

```bash
docker compose -f docker-compose.hub.yml stop trading-hub

node dist/hub-journal.js verify-backup \
  --from /app/data/backups/pre-deploy.db

node dist/hub-journal.js restore \
  --from /app/data/backups/pre-deploy.db \
  --db /app/data/hood-traders.db \
  --confirm-offline
```

Before replacement, the CLI creates a timestamped rollback snapshot of the current Journal. The restore source is validated before any target mutation. A staged copy is validated again before it replaces the target.

The `--confirm-offline` flag is an operator assertion, not process discovery. Do not use it while the Hub is still running.

## Rollback after a bad deploy

If application acceptance fails after a deploy:

1. Stop the new Hub process.
2. Locate the `.rollback-<timestamp>.db` file printed by the restore command.
3. Verify it with `verify`.
4. Restore it with the same offline procedure.
5. Start the prior application image/commit.
6. Re-run `/api/health`, wallet receipt reconciliation and pending bridge/launch checks.

Keep at least one known-good pre-deploy backup outside the active container filesystem. A Docker named volume protects against container replacement, not host/storage loss.

## What this tooling does not do

It does not upload backups off-host, schedule retention, stop/start services, rotate secrets, or deploy application images. Those belong to the hosting environment. It also does not make rollback safe while two Hub processes are writing the same SQLite file; the beta deployment must remain single-writer.
