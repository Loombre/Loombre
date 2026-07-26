# External PostgreSQL

Every Loombre install (Docker/Compose, the Linux tarball, the Windows MSI,
the macOS package) works equally against an external, operator-managed
PostgreSQL instead of the bundled embedded one — a NAS-hosted Postgres, a
managed cloud instance, a PostgreSQL your homelab already runs for other
services, or anything else. This is a first-class, equally-tested path
(D1), not a fallback.

## Turning it on

Set `DATABASE_URL` and Loombre never provisions, starts, stops, or
otherwise manages PostgreSQL's process lifecycle at all — this is a
structural guarantee, not just a default: `ExternalPostgresProvisioner`
(`packages/provisioning-pg/src/external.ts`) makes every mutating call
(`provision`/`start`/`stop`) throw, proven in both directions by that
package's own test suite. Loombre only ever *connects* to an external
instance; it never touches its data directory, config files, or process.

```bash
DATABASE_URL=postgres://loombre:yourpassword@your-pg-host:5432/loombre
```

Leaving `DATABASE_URL` unset is what selects embedded mode instead (a
bundled, pinned PostgreSQL Loombre provisions and manages itself under the
app-data dir) — the two modes are mutually exclusive and selected purely
by whether this one env var is set.

## Requirements

- **PostgreSQL 17 or newer** (D1 — 17 is the supported floor for external
  servers, `PROVISIONING_REQUEST_MIN_PG_MAJOR`; the embedded default is
  PostgreSQL 18, and the schema's migrations run on both).
- A database that exists already (Loombre runs migrations against it on
  boot; it does not `CREATE DATABASE`) — `CREATE DATABASE loombre OWNER
  loombre;` once, up front.
- A role with ordinary DDL+DML privileges on that database (Loombre's
  migrations create/alter tables, so the role needs more than
  read/write — a role that OWNS the database, or one with full
  privileges granted on it, is the simplest correct setup).
- Network reachability from wherever the Loombre server process runs to
  the PostgreSQL host/port in `DATABASE_URL`, including whatever
  TLS/`sslmode` requirements your PostgreSQL host enforces (append
  `?sslmode=require` or similar to the connection string if your host
  requires it — this passes straight through to the underlying driver
  unmodified).

## What you own vs. what Loombre owns, exactly

| | Embedded mode | External mode |
|---|---|---|
| Process start/stop | Loombre | You |
| Data directory location/layout | Loombre-managed (`<app-data>/postgres/data`) | Entirely yours |
| Major-version upgrades | Loombre's `UpgradePlan` flow (`docs/PLAN.md` §11, P4.2) | You (`pg_upgrade`, dump/restore, or your provider's own tooling) |
| Backups | Your responsibility either way — see `docs/ops/backup.md` | Your responsibility — same page, "External PostgreSQL" section |
| Superuser credential | Loombre-generated, stored via the P4.7 `SecretRef` seam (0600 file / OS keychain) | Whatever you put in `DATABASE_URL` — Loombre never generates or stores an external credential anywhere beyond that connection string |
| Corruption detection/recovery | Loombre's typed `CorruptionReport` surface (embedded mode only) | Your PostgreSQL host's own tooling |

## Migrating between modes

**External → embedded:** back up (per `docs/ops/backup.md`), unset
`DATABASE_URL`, let Loombre provision a fresh embedded instance on next
boot, then restore your dump into it.

**Embedded → external:** `pg_dumpall`/`pg_basebackup` the embedded
instance (`docs/ops/backup.md`'s embedded section — same commands, point
them at the embedded loopback port), restore into your external
instance, then set `DATABASE_URL` and remove/archive the old
`<app-data>/postgres/` directory once you've confirmed the external
instance is serving correctly.

Neither direction is automated in v1 — both are the manual dump/restore
drill `docs/ops/backup.md`'s "Restore drill" section already walks
through, just with the source and destination swapped.
