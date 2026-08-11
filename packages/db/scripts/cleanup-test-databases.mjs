#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/scripts/cleanup-test-databases.mjs
//
// Tiny, dependency-light (node-pg only) sweeper for leaked per-suite test
// databases — mirrors scripts/migrate.mjs's style (same DATABASE_URL
// convention, same plain-function-per-command shape, same
// connect-to-the-`postgres`-maintenance-database pattern that file's own
// ensureDatabaseExists already establishes).
//
// Why this exists: packages/db/src/testing.ts's ensureTestDatabase (and
// the local ensureFreshIsolatedDatabase helper a couple of spec files
// define for themselves — see packages/db/test/plugins-delivery.spec.ts,
// apps/worker/test/plugin-delivery/delivery-loop.integration.spec.ts)
// CREATEs a dedicated `<base>_<suffix>` database per self-sufficient
// live-DB test suite so sibling packages' `migrate.mjs reset` calls never
// race each other on a shared database (that file's own header has the
// full incident writeup) — but nothing ever DROPs one. Over enough test
// runs (CI, local dev, parallel worktree lanes each pointing DATABASE_URL
// at their own base name) these accumulate without bound: 1062 leaked
// databases / ~15 GB observed on the shared dev Postgres instance the day
// this script was written (STATE.md Task #11).
//
// Matching rule (DELIBERATELY the SAME regex scripts/migrate.mjs's `reset`
// guard uses, not a broader heuristic): a database is a cleanup CANDIDATE
// only if "test" appears as an underscore-delimited segment of its name
// (`isTestDatabaseName` below — copied verbatim from migrate.mjs, kept in
// sync by inspection since these are two independent plain scripts, not a
// shared module). This is surgical on purpose: every `ensureTestDatabase`
// call site in this repo uses a suffix ending in `_test`
// (`ensureTestDatabase(BASE_DATABASE_URL, "foo_test")`), so this rule
// catches the entire "created by the documented, current mechanism" set.
// It also deliberately does NOT catch every disposable-looking database on
// the server — a few call sites (`ensureFreshIsolatedDatabase`, a local
// helper a couple of spec files define for themselves with suffixes like
// "lpp_w4_plugins_delivery") and historical/renamed suffixes from past
// lane sessions produce names with no "_test" segment at all (e.g.
// "loombre_ipc", "loombre_lpp_w4_plugins_delivery") — this script leaves
// those alone rather than guess. Matching the reset guard's own trusted
// rule exactly means "this script and `migrate.mjs reset` agree on what
// counts as a test database", which is the property that actually matters
// here: nothing this script is willing to DROP is a database `reset`
// wasn't ALREADY willing to blow away via DROP SCHEMA CASCADE.
//
// Refuses to touch, unconditionally: `loombre` (the real dev database),
// `postgres` (the maintenance database itself), whatever database
// DATABASE_URL itself points at (opus-review LD wave, Finding 4 — a dev
// stack pinned at, say, `.../loombre_test` would otherwise BE a candidate:
// it matches isTestDatabaseName, and "zero active connections" is not a
// reliable guard for it either — a dev stack between requests, or one that
// connects per-request rather than holding a pool open, can sit at zero
// pg_stat_activity rows for this script's entire runtime despite being the
// database someone is actively developing against), any `template*`
// database, and — regardless of name — any database with one or more live
// connections at the moment this runs (pg_stat_activity), so a suite
// mid-run on a shared server is never yanked out from under it.
//
// Usage:
//   node scripts/cleanup-test-databases.mjs            # dry run (default)
//   node scripts/cleanup-test-databases.mjs --dry-run   # same, explicit
//   node scripts/cleanup-test-databases.mjs --execute   # actually DROPs
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre
// (only its host/port/credentials are used — this ALWAYS connects to the
// `postgres` maintenance database on that server, same as migrate.mjs's
// ensureDatabaseExists, so it works regardless of whether DATABASE_URL's
// own named database exists, and never has to DROP the database it is
// itself connected to.)

import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

// KEEP IN SYNC with scripts/migrate.mjs's isTestDatabaseName — see this
// file's header for why the two must agree.
function isTestDatabaseName(name) {
  return /(^|_)test(_|$)/.test(name);
}

// The database DATABASE_URL itself names (its URL path, sans the leading
// `/`) — see NEVER_TOUCH just below / this file's header, Finding 4.
function pinnedDatabaseName(databaseUrl) {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

const NEVER_TOUCH = new Set(['loombre', 'postgres', pinnedDatabaseName(DATABASE_URL)]);

function isProtected(name) {
  return NEVER_TOUCH.has(name) || name.startsWith('template');
}

function maintenanceUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function formatBytes(bytes) {
  // Finding 5: `size_bytes` is NULL for a database this role lacks CONNECT
  // privilege on (see listAllDatabases's CASE WHEN) — report that plainly
  // rather than letting `Number(null)` silently print "0 B" (a real,
  // materially different claim: "confirmed empty" vs. "could not check").
  if (bytes === null || bytes === undefined) return 'size unknown (no CONNECT privilege)';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/**
 * Every non-template database on the server, with its size and current
 * connection count in one pass. `pg_database_size` is safe to call from
 * the maintenance connection for every database this role CREATEd itself
 * (every candidate here was CREATEd by the same `loombre` role via
 * ensureTestDatabase/ensureFreshIsolatedDatabase, which always connects as
 * whatever DATABASE_URL's credentials are) — but `pg_database_size` throws
 * a permission error for ANY database the connected role lacks CONNECT
 * privilege on (opus-review LD wave, Finding 5), and Postgres evaluates it
 * per-row as part of executing this ONE query, so a single such database
 * anywhere on the server (a differently-owned database from an unrelated
 * app sharing this Postgres instance, say) would abort this entire SELECT
 * — not just that row — hiding every OTHER database's real size/candidacy
 * behind an unrelated permission error. `has_database_privilege` guards
 * the call per-row instead: `size_bytes` is NULL (formatBytes below
 * reports "size unknown") for a database this role can't inspect, but the
 * row itself, and its name/active_connections, are still returned — never
 * silently dropped from consideration.
 */
async function listAllDatabases(client) {
  const { rows } = await client.query(`
    SELECT
      d.datname AS name,
      CASE
        WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname)
        ELSE NULL
      END AS size_bytes,
      (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS active_connections
    FROM pg_database d
    WHERE d.datistemplate = false
    ORDER BY d.datname
  `);
  return rows;
}

async function main() {
  const execute = process.argv.includes('--execute');

  const admin = new pg.Client({ connectionString: maintenanceUrl(DATABASE_URL) });
  await admin.connect();
  try {
    const all = await listAllDatabases(admin);

    const candidates = [];
    const skippedProtected = [];
    const skippedNotTestNamed = [];
    const skippedActiveConnections = [];

    for (const row of all) {
      if (isProtected(row.name)) {
        skippedProtected.push(row);
        continue;
      }
      if (!isTestDatabaseName(row.name)) {
        skippedNotTestNamed.push(row);
        continue;
      }
      if (row.active_connections > 0) {
        skippedActiveConnections.push(row);
        continue;
      }
      candidates.push(row);
    }

    const totalServerCount = all.length;
    const totalServerBytes = all.reduce((sum, r) => sum + Number(r.size_bytes), 0);
    const candidateBytes = candidates.reduce((sum, r) => sum + Number(r.size_bytes), 0);

    // Finding 4: the protected set — including whatever database
    // DATABASE_URL itself currently points at — printed unconditionally,
    // regardless of whether any of them actually exist on this server, so
    // a human reading dry-run output can see the rule (not just its
    // effect) before anything is ever dropped.
    console.log(`cleanup-test-databases: protected, never touched, regardless of name: ${[...NEVER_TOUCH].join(', ')}, and any "template*" database.`);
    if (skippedProtected.length > 0) {
      console.log(
        `cleanup-test-databases: ${skippedProtected.length} protected database(s) present on this server: ` +
        `${skippedProtected.map((r) => r.name).join(', ')}.`
      );
    }
    console.log(`cleanup-test-databases: ${totalServerCount} database(s) on the server, ${formatBytes(totalServerBytes)} total.`);
    console.log(
      `cleanup-test-databases: ${candidates.length} candidate(s) match the test-name rule and have no active connections, ` +
      `${formatBytes(candidateBytes)} reclaimable.`
    );
    if (skippedActiveConnections.length > 0) {
      console.log(
        `cleanup-test-databases: skipping ${skippedActiveConnections.length} test-named database(s) with a live connection ` +
        `right now: ${skippedActiveConnections.map((r) => r.name).join(', ')}`
      );
    }
    console.log(
      `cleanup-test-databases: ${skippedNotTestNamed.length} other database(s) left untouched (name has no "_test" segment — ` +
      `outside this script's surgical matching rule, see this file's header).`
    );

    if (candidates.length === 0) {
      console.log('cleanup-test-databases: nothing to do.');
      return;
    }

    if (!execute) {
      console.log('');
      console.log('cleanup-test-databases: DRY RUN (default) — would DROP the following:');
      for (const row of candidates) {
        console.log(`  ${row.name}  (${formatBytes(row.size_bytes)})`);
      }
      console.log('');
      console.log('cleanup-test-databases: re-run with --execute to actually drop these.');
      return;
    }

    console.log('');
    console.log(`cleanup-test-databases: --execute given — dropping ${candidates.length} database(s)...`);
    let droppedCount = 0;
    let droppedBytes = 0;
    let failedCount = 0;
    for (const row of candidates) {
      try {
        // Cannot be parameterized or run inside a transaction; `row.name`
        // came from pg_database itself (a real, currently-existing
        // database name on this server), not unvalidated input, quoted
        // defensively regardless.
        await admin.query(`DROP DATABASE "${row.name.replace(/"/g, '""')}"`);
        console.log(`  dropped ${row.name}  (${formatBytes(row.size_bytes)})`);
        droppedCount += 1;
        droppedBytes += Number(row.size_bytes);
      } catch (err) {
        // A database can pick up a connection (or vanish — a concurrent
        // cleanup run, or a suite starting up) between the listing above
        // and this DROP; log and continue rather than aborting the whole
        // sweep over one database.
        console.log(`  FAILED to drop ${row.name}: ${err.message}`);
        failedCount += 1;
      }
    }

    console.log('');
    console.log(
      `cleanup-test-databases: dropped ${droppedCount}/${candidates.length} database(s), reclaimed ${formatBytes(droppedBytes)}` +
      (failedCount > 0 ? `, ${failedCount} failed (see above).` : '.')
    );

    const after = await listAllDatabases(admin);
    const afterBytes = after.reduce((sum, r) => sum + Number(r.size_bytes), 0);
    console.log(`cleanup-test-databases: ${after.length} database(s) remain on the server, ${formatBytes(afterBytes)} total.`);
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
