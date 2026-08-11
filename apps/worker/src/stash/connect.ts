// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/connect.ts
//
// The connection-lifecycle entry point (STATE.md S1-S3, K12) — ties
// together stash-connections.ts's config row (Postgres), adapter.ts's
// read-only open/retry/snapshot (S2), and guard.ts's schema check (S3)
// into the one function apps/worker/src/metadata/providers/stash.ts
// (Lane A's provider factory) and any future Lane C sync job call to open
// a library's Stash database. Every call here records its outcome onto
// library_stash_connections (recordStashConnectionOutcome) — this is the
// ONLY place that table's status columns are written, so "last observed
// outcome" (the migration's own doc comment) is never stale relative to
// what actually happened.
//
// S3's event (`stash.provider.disabled`, admin-only, K12): written in the
// SAME transaction pattern apps/worker/src/probe/terminal-failure-hook.ts
// uses (withTransaction + writeEvent) — see that file's header for the
// precedent this mirrors.
//
// Stash OPEN ledger item 7's event (`stash.provider.connected`, admin-only):
// unlike `disabled` above, gated on a genuine status TRANSITION (see its
// own inline comment at the write site) — this function is called
// per-scene during ordinary metadata fetches, so firing unconditionally
// would flood the event feed on every healthy scan.

import { getLibraryStashConnection, recordStashConnectionOutcome } from '@loombre/db';
import { withTransaction, writeEvent, type DbOrTx } from '@loombre/db/internal';
import { openStashConnection, type StashAdapterDeps, type StashConnection, type OpenStashConnectionOptions } from './adapter.js';
import { STASH_SUPPORTED_SCHEMA_MAX, STASH_SUPPORTED_SCHEMA_MIN, checkStashSchemaVersion, readSchemaVersion } from './guard.js';

export interface ConnectToStashLibraryDeps {
  db: DbOrTx;
  clock?: () => number;
  adapterDeps?: StashAdapterDeps;
  /** Test seam for the adapter's retry/backoff timing — production
   *  callers never set this (adapter.ts's own defaults apply). */
  openOptions?: Partial<OpenStashConnectionOptions>;
}

export type StashConnectOutcome =
  | { status: 'ok'; connection: StashConnection; schemaVersion: number }
  | { status: 'unsupported_schema'; notice: string; seenVersion: number }
  | { status: 'unreachable'; reason: string };

/**
 * Opens `libraryId`'s configured Stash database end to end: reads the
 * config row, opens read-only through S2's retry/snapshot fallback, reads
 * and checks the schema version (S3), and records the outcome. Never
 * throws for an expected failure mode (missing config, disabled
 * connection, unreachable file, unsupported schema) — every one of those
 * is a `StashConnectOutcome` variant, not an exception; only a genuinely
 * unexpected error (a Postgres failure, say) propagates.
 */
export async function connectToStashLibrary(deps: ConnectToStashLibraryDeps, libraryId: string): Promise<StashConnectOutcome> {
  const nowMs = (deps.clock ?? Date.now)();

  const connRow = await getLibraryStashConnection(deps.db, libraryId);
  if (!connRow) {
    return { status: 'unreachable', reason: 'no library_stash_connections row configured for this library' };
  }
  if (!connRow.enabled) {
    // Admin-disabled: deliberately does NOT call recordStashConnectionOutcome
    // — an admin toggling `enabled` off is a config decision, not an
    // observed connection outcome, and must not overwrite the last real
    // status (stash-connections.spec.ts's "config-only write leaves
    // status alone" contract, extended here to "disabled" too).
    return { status: 'unreachable', reason: 'connection is disabled' };
  }

  let stashConn: StashConnection;
  try {
    stashConn = await openStashConnection({ path: connRow.sqlite_path, ...deps.openOptions }, deps.adapterDeps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordStashConnectionOutcome(deps.db, { libraryId, status: 'unreachable', statusDetail: reason, nowMs });
    return { status: 'unreachable', reason };
  }

  let schema;
  try {
    schema = readSchemaVersion(stashConn.db);
  } catch (err) {
    stashConn.close();
    const reason = err instanceof Error ? err.message : String(err);
    await recordStashConnectionOutcome(deps.db, { libraryId, status: 'unreachable', statusDetail: reason, nowMs });
    return { status: 'unreachable', reason };
  }

  const guardResult = checkStashSchemaVersion(schema);
  if (!guardResult.supported) {
    stashConn.close();
    await recordStashConnectionOutcome(deps.db, {
      libraryId,
      status: 'unsupported_schema',
      statusDetail: guardResult.notice,
      lastSeenSchemaVersion: guardResult.version,
      nowMs,
    });
    await withTransaction(deps.db, async (trx) => {
      await writeEvent(trx, {
        type: 'stash.provider.disabled',
        tsMs: nowMs,
        actorUserId: null,
        payload: {
          libraryId,
          seenVersion: guardResult.version,
          supportedMin: STASH_SUPPORTED_SCHEMA_MIN,
          supportedMax: STASH_SUPPORTED_SCHEMA_MAX,
          notice: guardResult.notice,
        },
      });
    });
    return { status: 'unsupported_schema', notice: guardResult.notice, seenVersion: guardResult.version };
  }

  await recordStashConnectionOutcome(deps.db, { libraryId, status: 'ok', lastSeenSchemaVersion: guardResult.version, nowMs });
  // Stash OPEN ledger item 7 ("No success-connect event — the admin must
  // reopen the Stash modal to see a status flip"): admin-only
  // `stash.provider.connected`, TRANSITION-GATED on `connRow.status` (read
  // above, BEFORE this attempt) — unlike `stash.provider.disabled` above,
  // which fires unconditionally on every failed attempt, this function is
  // called PER-SCENE during ordinary metadata fetches
  // (apps/worker/src/metadata/providers/stash.ts's fetchDetails), so an
  // unconditional emit here would flood the event feed with thousands of
  // redundant "connected" events during one ordinary scan of an
  // already-healthy library. Firing only on a genuine transition INTO 'ok'
  // (from 'never_connected', 'unreachable', or 'unsupported_schema') keeps
  // the event meaningful — exactly one per real "it just started working"
  // moment, which is what a modal watching for a live status flip needs.
  if (connRow.status !== 'ok') {
    await withTransaction(deps.db, async (trx) => {
      await writeEvent(trx, {
        type: 'stash.provider.connected',
        tsMs: nowMs,
        actorUserId: null,
        payload: { libraryId, schemaVersion: guardResult.version },
      });
    });
  }
  return { status: 'ok', connection: stashConn, schemaVersion: guardResult.version };
}
