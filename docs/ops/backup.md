# Backups and restore

Loombre has **no automatic scheduled backup of its own** — the
pre-upgrade backup described below is a safety net for ONE specific
operation (a PostgreSQL major-version upgrade), not a substitute for your
own regular backup schedule. Set up real backups per this page before you
have real data you'd miss.

## What actually needs backing up

| Path | What it is | Back up? |
|---|---|---|
| The PostgreSQL data (embedded: `<app-data>/postgres/data`; external: wherever your PG install keeps it) | The entire catalog: users, libraries, watch state, metadata, restricted-content config, job ledger — everything except media files themselves | **Yes — this is the database.** |
| `<app-data>/tls/` | ACME account key + issued cert/key (`docs/ops/remote-access/acme.md`) | Optional — cheap to re-issue from Let's Encrypt if lost; the account key regenerating just means a fresh CA account, not data loss. Back up if you want zero re-issuance friction after a restore. |
| `<app-data>/postgres/superuser.secret` | The embedded-PG superuser credential (P4.7 `SecretRef` file0600) | **Yes, alongside the data dir** — a data-dir-only restore with a lost/mismatched secret file cannot start the restored cluster. |
| Your media library itself | The actual video/audio files | Your call — most operators treat this as separately protected (RAID, a different backup tool, or simply "re-rip from the original disc/source") given its size; Loombre never modifies your media files in place. |
| `<app-data>/transcode/` (staging area for in-flight transcodes) | **Ephemeral working state — explicitly do NOT back this up.** Deleting it is always safe; it's fully reconstructed the next time each affected item is played. Including it in a backup wastes space and restoring it can't meaningfully "resume" anything (`transcode_sessions` rows and `playback_sessions` are the source of truth on restore, not partial segment files). |

## Embedded PostgreSQL

Two supported approaches — either is a real, correct backup; pick based
on how large your library is:

### `pg_dumpall` (simplest, correct for small-to-medium libraries)

```bash
# The embedded instance listens on TCP loopback, port from
# LOOMBRE_EMBEDDED_PG_PORT (default 5433) — see bootstrap/provisioning.ts.
PGPASSWORD=<from superuser.secret> pg_dumpall -h 127.0.0.1 -p 5433 -U postgres \
  | gzip > loombre-backup-$(date +%Y%m%d-%H%M%S).sql.gz
```

Requires the server to be UP (dump reads through the live connection —
this is a logical, online backup, not a filesystem snapshot; PostgreSQL's
own MVCC gives you a consistent snapshot without needing to stop
anything). Restore into a fresh cluster with `psql < backup.sql`
(uncompressed) or `zcat backup.sql.gz | psql`.

### Filesystem-level `pg_basebackup` (faster restore for large catalogs)

```bash
PGPASSWORD=<from superuser.secret> pg_basebackup -h 127.0.0.1 -p 5433 -U postgres \
  -D /path/to/backup-dir -Ft -z -P
```

Also an online, non-blocking backup (PostgreSQL's own WAL-based
mechanism — no downtime required). Restore by stopping Loombre, replacing
`<app-data>/postgres/data` with the extracted basebackup contents, and
restarting — faster to restore than replaying a full logical dump for a
large catalog, at the cost of a bigger backup artifact.

### The pre-upgrade backup is NOT your backup strategy

`packages/provisioning-pg`'s `UpgradePlan` (P4.2, the automated
PG-major-version-upgrade flow) includes a `backup` step: a full
`cpSync`-based copy of the live data directory to a caller-supplied path,
BEFORE any destructive step (`dumpall`/`initdb-new`/`restore`/`swap`)
runs, verified by checking `PG_VERSION` exists in the copy before
proceeding. This exists so a failed/interrupted major-version upgrade
never destroys your only copy of the data — it is a safety net for that
ONE operation, invoked automatically as part of the upgrade flow, at a
path the upgrade caller chooses (not a fixed, discoverable location you
should rely on finding later). Treat it as "the upgrade didn't eat your
data," not as "I have backups."

## External PostgreSQL

If you set `DATABASE_URL` (external mode — see `docs/ops/
external-postgres.md`), Loombre never touches PostgreSQL's own lifecycle
at all: backups are entirely your existing PostgreSQL backup tooling's
job (whatever you already use for any other database on that instance —
`pg_dump`/`pg_basebackup`/a managed provider's own snapshot feature/WAL
archiving). The two commands above work identically against an external
instance; just point `-h`/`-p`/`-U` at your real connection details
instead of the embedded loopback ones.

## Restore drill

A backup you have never restored is a hope, not a backup. Periodically:

1. Stop Loombre.
2. Restore into a SEPARATE, scratch PostgreSQL instance (never test
   directly against your live data dir) — either `psql` the dump into a
   fresh `createdb`, or point a scratch embedded instance's data dir at
   an extracted basebackup.
3. Point a scratch `DATABASE_URL` at it and confirm the server boots and
   basic reads work (`GET /system/capabilities`, a library listing).
4. Confirm the row counts you expect are actually there (user count,
   library count, item count — whatever you know your real numbers
   roughly are).

If step 3/4 fails, you've found a broken backup while it's still just an
inconvenience, not a crisis.

## Rolling back a failed migration

Database migrations are **forward-only** (docs/PLAN.md §4.2) —
`packages/db/migrations/*.sql` ships no `down` counterpart for any
migration, on principle, not as a gap to be filled in later. There is
nothing to "undo" a migration with.

If a new Loombre release's migration step fails partway, or completes but
the new version misbehaves once running, the only rollback path is: stop
the server, restore the pre-upgrade backup you took before applying the
update (see above — this is exactly the scenario that backup was for),
then either stay on the old application version against the restored data
until a fix ships, or roll forward again once a corrected migration is
available. `pnpm db:migrate`/`node scripts/migrate.mjs migrate` is
idempotent and safe to re-run (already-applied migrations are skipped by
filename, tracked in `schema_migrations`) — but it only ever moves the
schema forward, never back.
