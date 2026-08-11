// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-path-guard.ts
//
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  LD-9 DESIGN NOTE — serializing remote-path enables (V-SEC F2)        ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// STATE.md's LD register, LD-9; closes the "Loombre Remote" OPEN-ledger
// item `[OPEN — owner decision, V-SEC F2 LOW]`. This module is the whole
// mechanism; everything below is the argument for why it is shaped exactly
// this way. The Wave-D reviewer's charter is to attack this note, so it
// states its own failure modes.
//
// ── 1. THE RACE ────────────────────────────────────────────────────────
// RG15: at most one of the three remote-access paths (remote/tunnel/
// direct) may be enabled at a time. Each path's staged enable flow
// enforced that with a NON-TRANSACTIONAL check-then-commit:
//
//   t0  Tunnel enable reads resolveActivePath() -> 'none'          [ok]
//   t1  ... 8+ sequential Cloudflare API round-trips, a keyring
//       write, and a cloudflared child-process spawn (multi-second)
//   t2  WireGuard enable reads resolveActivePath() -> 'none'       [ok]
//   t3  WireGuard commits enabled=true
//   t4  Tunnel commits enabled=true
//
// Both land. Every subsequent remote READ then goes through
// deriveActivePath(), observes two paths enabled, and throws
// RemoteActivePathInvariantViolationError -> a real 500 on the admin's
// own remote screens. Admin-only, low-probability, recoverable by a
// normal disable — but a genuine correctness hole, and the resolver
// invariant that reports it is a symptom, never the enforcement.
//
// ── 2. THE MECHANISM SHIPPED ───────────────────────────────────────────
// The invariant is a DATABASE invariant ("at most one of these three rows
// says enabled"), so it is enforced where it lives: inside the SAME
// transaction that writes the row, under a transaction-scoped Postgres
// advisory lock keyed by one fixed constant every enable shares.
//
//   withRemotePathEnableGuard(db, path, fn):
//     BEGIN
//       SELECT pg_advisory_xact_lock(hashtext('loombre:remote:active-path'))
//       read the three subsystems' `enabled` flags
//       if any OTHER path is enabled -> throw RemotePathConflictError
//       fn(trx)          -- the caller's row write + its outbox events
//     COMMIT
//
// It is applied INSIDE enableRemoteWireguardAndEmit /
// enableTunnelStateAndEmit / enableRemoteDirectStateAndEmit, not at their
// call sites: the guarantee is compiled in, exactly the posture CLAUDE.md
// invariant 4 takes for the catalog guard ("must be impossible, not
// discouraged"). There is no exported way to enable a path that skips it.
//
// The pre-existing 409 checks at the three apps/server enable flows STAY.
// They are a fail-fast optimization — they stop the common case (another
// path is ALREADY active) before a single Cloudflare call is made. They
// are explicitly NOT the enforcement any more, and each one now says so.
//
// Why an advisory lock and not a constraint: the three paths' `enabled`
// bits live in three different places (remote_wireguard_state,
// remote_tunnel_state, and a server_settings JSONB row — a frozen schema
// this lane does not get to redesign). No unique index, partial or
// otherwise, can span them. This is the same argument src/query/
// notices.ts's own lock header makes for the one-active-notice invariant,
// and the same primitive src/query/identity.ts's createFirstAdminIfEmpty
// uses for exactly-one-first-admin. House precedent, not invention.
// (src/query/remote-probes.ts documents the opposite call — a single-row
// CAS needs no advisory lock. The house convention is to argue lock-or-
// no-lock at the site; this is that argument.)
//
// Why the lock is required even though the read+write is one transaction:
// under READ COMMITTED two overlapping transactions cannot see each
// other's uncommitted write, so both would read "nothing else enabled"
// and both would commit. The lock is what makes the second one WAIT and
// then re-read. This depends on the lock statement being FIRST in the
// transaction and on READ COMMITTED semantics (each statement takes a
// fresh snapshot): the waiter wakes only after the winner's COMMIT, and
// its subsequent read therefore sees the winner's row. Under REPEATABLE
// READ the snapshot would predate the winner and the guard would be
// unsound — this package never sets a non-default isolation level
// (src/internal/tx.ts's withTransaction takes Kysely's default), and this
// is the one dependency that would silently break the guard if that ever
// changed. Stated here so a future isolation-level change trips over it.
//
// ── 3. THE RELEASE GUARANTEE (the LD-9 engineering requirement) ─────────
// "The mechanism MUST guarantee release on any thrown external side
// effect; no permanent-lockout mode exists, by construction."
//
// It holds because of WHERE the lock is held, not because of any cleanup
// code:
//
//   (a) The lock is acquired ONLY inside withRemotePathEnableGuard, and
//       only ever as the first statement of a transaction it also owns.
//       There is no acquire path outside a transaction.
//   (b) The guarded region contains NO external I/O of any kind — no
//       HTTP, no keyring, no filesystem, no child process, no callback
//       that could do any of those. It is: one lock statement, three
//       SELECTs, and the caller's own INSERT/UPDATE + outbox writes. Its
//       duration is bounded by Postgres round-trips, not by Cloudflare.
//   (c) `pg_advisory_xact_lock` is released by PostgreSQL itself at
//       COMMIT **or ROLLBACK**. A throw inside `fn` aborts the
//       transaction; the lock goes with it. This is not a finally-block
//       promise — there is no unlock call to forget.
//   (d) A killed connection or a crashed/OOM-killed server process ends
//       the backend session; PostgreSQL aborts its open transaction and
//       releases every lock it held. Nothing survives to be leaked. This
//       is strictly stronger than a session-scoped `pg_advisory_lock`,
//       which would persist on a pooled connection that was returned
//       without an explicit unlock.
//   (e) A hung *external* call cannot hold the lock, because no external
//       call happens inside it. The pathological "admin's enable wedged
//       on a 90-second Cloudflare timeout while everyone else waits" state
//       is not reachable.
//
// So the lockout window is not "short" or "bounded by a TTL" — it is
// structurally absent. The strongest statement available is the one that
// holds: the lock's lifetime is the lifetime of a transaction that only
// ever talks to PostgreSQL.
//
// ── 4. REJECTED: a lock spanning the external side effects ─────────────
// The obvious reading of "serialize enables" is one lock held from the
// pre-check through the provider calls to the commit. Rejected:
//
//   - It requires an open transaction across ~8 sequential Cloudflare API
//     round-trips plus a keyring write plus a child-process spawn. That
//     pins one pooled connection for the whole time; createDb() builds a
//     stock `pg.Pool` (default max 10), so a single enable would hold 10%
//     of the server's entire database capacity while waiting on a third
//     party's network.
//   - `idle_in_transaction_session_timeout` is a normal production
//     setting. Any deployment that sets it below the Cloudflare
//     provisioning time would have the enable's transaction killed by the
//     database, mid-flight, after the external side effects had already
//     landed — converting a slow enable into an orphaned Cloudflare
//     tunnel. The mechanism would be at the mercy of an unrelated knob.
//   - It would put an apps/server callback that performs network I/O
//     inside a packages/db transaction — inverting the layering CLAUDE.md
//     invariant 4 exists to protect.
//   - The one thing it buys — the loser never starts provisioning — is
//     bought at the cost of the loser instead BLOCKING for the whole
//     provisioning window before finding out. Neither is free; only this
//     one holds a connection and an XID hostage while it happens.
//
//   Note that even this rejected design would NOT permanently lock out:
//   xact-scoped release still applies. It is rejected on cost and
//   fragility, not on the release guarantee. Saying otherwise would
//   overstate the case.
//
// ── 5. REJECTED: a two-phase claim row ─────────────────────────────────
// Phase 1 takes a short lock and writes a claim row {path, expiresAtMs};
// phase 2 does the external side effects unlocked; phase 3 commits the
// real enable and clears the claim. It keeps the lock short AND stops the
// loser before it provisions. Rejected:
//
//   - Its release guarantee is application-level, not PostgreSQL-level.
//     A crashed server between phase 1 and phase 3 leaves a COMMITTED
//     claim row that no `finally` block will ever run to clear. The only
//     answer is a TTL — i.e. a real, if bounded, lockout window, which is
//     precisely the class of thing LD-9 says must not exist by
//     construction.
//   - The TTL is unsatisfiable in both directions. It must exceed the
//     slowest legitimate enable or it expires under a live enable and
//     reopens the very race it exists to close; it must be short or a
//     crash blocks recovery for its whole duration. "Slowest legitimate
//     Cloudflare provisioning" is a third party's number, not ours.
//   - It needs a new table or a new server_settings key, a new writer, a
//     staleness sweeper, and its own concurrency story for claim
//     expiry-vs-commit — strictly more moving parts, each with its own
//     failure mode, in exchange for a weaker guarantee.
//
// ── 6. WHAT THE LOSER OF A REAL RACE PAYS ──────────────────────────────
// The cost of moving enforcement to the commit is that a loser may have
// already performed its external side effects. It must undo them. Each
// enable flow now catches RemotePathConflictError, compensates, and
// re-throws the house 409 (`code: "remote-path-active"`):
//
//   - Tunnel  — stop the connector, remove the DNS route, deprovision the
//               tunnel, clear the stored connector credentials. This is
//               the SAME teardown disableRemoteTunnel already performs
//               (R8 "verified teardown"), reused, not reinvented; the
//               enable flow already had the identical compensation for a
//               failed createDnsRoute.
//   - Remote  — stop the runtime (drops the UDP listener + the loopback
//               backend). The freshly generated private key stays in the
//               keyring, unreferenced: no DB row points at it, and the
//               next real enable overwrites it. That is the pre-existing
//               behaviour for ANY failure after storePrivateKey, not a
//               new leak.
//   - Direct  — restore tls.mode from the pre-enable snapshot it had
//               already captured. Mirrors disableRemoteDirect's own
//               revert exactly (tls.acmeDomains/tls.acmeTosAgreed are
//               deliberately left, same as disable).
//
// Compensation is best-effort by necessity (it is itself external I/O and
// can fail). It cannot fail *silently* into a wrong DB state, though: the
// losing enable's row write never happened — it was rolled back with the
// transaction — so the database is correct regardless of whether the
// compensating Cloudflare DELETE succeeded. The worst case is an orphaned
// remote resource plus a 409, which is strictly better than the
// pre-LD-9 worst case of two paths enabled plus a 500 on every read.
//
// Losing a race requires two admins enabling two different paths within
// the same few seconds. The rare case pays; the common case pays nothing.
//
// ── 7. DISABLE AND RECOVERY CAN NEVER BE BLOCKED ───────────────────────
// A stated LD-9 obligation, and the reason the original deferral existed.
// Three independent reasons, in increasing strength:
//
//   1. No disable path calls this guard. disableRemoteWireguardAndEmit,
//      disableTunnelStateAndEmit and disableRemoteDirectStateAndEmit take
//      no advisory lock at all, and no disable flow consults
//      resolveActivePath. Turning a path OFF is always safe and always
//      available. (Pinned by a test that holds this exact advisory lock
//      from a separate session and proves all three disables — and
//      resolveActivePath itself — still complete.)
//   2. Nothing else in the repo takes this key. It is used in exactly one
//      function, in this file.
//   3. Even a hypothetical future disable-side lock could not wedge:
//      there is no state in which this lock is held for longer than a
//      PostgreSQL-only transaction (§3b), so "a stuck enable" is not a
//      state that exists.
//
// Reads are equally unaffected: resolveActivePath and every status/
// posture read run outside the guard and take no lock.
//
// ── 8. DEADLOCK AND KEY-COLLISION ──────────────────────────────────────
// Exactly one advisory-lock key is ever acquired here, always as the
// first statement of its transaction, and no other advisory lock is
// acquired inside the guarded region — so there is no lock-ordering
// cycle to deadlock on, with notices.ts's key, identity.ts's key, or
// anything else. A hashtext collision with another module's key would
// merely make two unrelated admin mutations serialize with each other;
// it can never lose the mutual exclusion this guard needs.
//
// ── 9. WHAT REMAINS, DELIBERATELY ──────────────────────────────────────
// deriveActivePath's RemoteActivePathInvariantViolationError stays, as
// defense-in-depth, with its comment rewritten from "known limitation" to
// "believed unreachable, and here is why". It is now a claim about the
// world rather than an accepted defect: reaching it requires a writer
// that bypasses this package's three enable functions entirely (direct
// SQL, a restored inconsistent backup, a future fourth path that forgets
// the guard). Loud is still the right response to that.

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../types.js';
import { withTransaction } from '../internal/index.js';

/** The four values RemotePathId can take — re-declared here rather than
 *  imported from query/remote-direct.ts, which imports THIS module for
 *  REMOTE_DIRECT_STATE_KEY (dependency-cruiser's no-circular rule is an
 *  error-severity gate). query/remote-direct.ts re-exports the canonical
 *  `RemotePathId` name from this alias, so there is exactly one type. */
export type RemotePathIdValue = 'none' | 'remote' | 'tunnel' | 'direct';

/** The three subsystems' own `enabled` booleans — the raw input to
 *  deriveActivePath (query/remote-active-path.ts). */
export interface RemoteActivePathFlags {
  remote: boolean;
  tunnel: boolean;
  direct: boolean;
}

/** The Direct path's internal-state row key in `server_settings`
 *  (deliberately NOT a SETTINGS_REGISTRY key — see query/remote-direct.ts's
 *  header for the whole argument). Declared here because readRemotePathFlags
 *  below must read it without importing that module (§ the no-circular
 *  note above); query/remote-direct.ts imports it FROM here, so the literal
 *  exists exactly once. */
export const REMOTE_DIRECT_STATE_KEY = 'remote.direct.internalState';

/** The one advisory-lock key every remote-path enable shares. */
const REMOTE_PATH_ENABLE_LOCK_KEY = 'loombre:remote:active-path';

/**
 * Thrown by withRemotePathEnableGuard when, under the lock, some OTHER
 * remote-access path is already enabled. apps/server's three enable flows
 * catch this, compensate for whatever external side effects they had
 * already performed, and re-throw the house 409 problem
 * (`code: "remote-path-active"`) — packages/db never imports the HTTP
 * problem helpers, so the mapping lives at the boundary, not here.
 */
export class RemotePathConflictError extends Error {
  constructor(
    /** The path that is actually enabled — what the 409 should name. */
    public readonly activePath: RemotePathIdValue,
    /** The path whose enable just lost. */
    public readonly attemptedPath: RemotePathIdValue,
  ) {
    super(
      `Cannot enable the ${attemptedPath} remote-access path — the ${activePath} path is already active (RG15: at most one may be enabled at a time). Disable it first.`,
    );
    this.name = 'RemotePathConflictError';
  }
}

/**
 * THE single reader of the three subsystems' `enabled` bits — used both by
 * this guard (under the lock) and by resolveActivePath (unlocked), so the
 * enforcement and the derivation can never disagree about what "enabled"
 * means. Accepts a Transaction as well as a Kysely handle: the guard reads
 * through its own transaction, so its reads sit inside the locked region.
 *
 * Absence is disabled, for all three, matching each module's own documented
 * default: remote_wireguard_state has no row until the first ever enable;
 * remote_tunnel_state's singleton row is migration-seeded but is read
 * defensively all the same; the Direct path has no server_settings row until
 * its first enable.
 */
export async function readRemotePathFlags(db: Kysely<DB> | Transaction<DB>): Promise<RemoteActivePathFlags> {
  const [wireguard, tunnel, direct] = await Promise.all([
    db.selectFrom('remote_wireguard_state').select('enabled').where('id', '=', true).executeTakeFirst(),
    db.selectFrom('remote_tunnel_state').select('enabled').where('id', '=', 1).executeTakeFirst(),
    db.selectFrom('server_settings').select('value').where('key', '=', REMOTE_DIRECT_STATE_KEY).executeTakeFirst(),
  ]);

  const directValue = direct?.value as { enabled?: boolean } | undefined;

  return {
    remote: wireguard?.enabled === true,
    tunnel: tunnel?.enabled === true,
    direct: directValue?.enabled === true,
  };
}

/**
 * LD-9's mechanism. Runs `fn` inside ONE transaction that has already
 * (a) taken the shared transaction-scoped advisory lock and (b) proven,
 * under that lock, that no path other than `path` is enabled.
 *
 * Release is PostgreSQL's, not ours: `pg_advisory_xact_lock` is dropped at
 * COMMIT or ROLLBACK, and a dead session's transaction is aborted by the
 * server. `fn` must therefore never perform external I/O — see this file's
 * design note §3. Every current caller is an *AndEmit writer in this same
 * package whose body is pure SQL.
 *
 * Re-entrant through withTransaction: passing an existing Transaction reuses
 * it (and re-taking the same advisory lock in the same transaction is a
 * documented no-op — advisory locks are re-entrant per session).
 */
export async function withRemotePathEnableGuard<T>(
  db: Kysely<DB>,
  path: Exclude<RemotePathIdValue, 'none'>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${REMOTE_PATH_ENABLE_LOCK_KEY})::bigint)`.execute(trx);

    const flags = await readRemotePathFlags(trx);
    const enabledOther = (['remote', 'tunnel', 'direct'] as const).find((candidate) => candidate !== path && flags[candidate]);
    if (enabledOther !== undefined) {
      throw new RemotePathConflictError(enabledOther, path);
    }

    return fn(trx);
  });
}

/** TEST-ONLY export (packages/db/test/remote-path-enable-serialization.spec.ts):
 *  the literal key, so a spec can hold the SAME lock from an independent
 *  session and prove the disable/read paths are not blocked by it. Nothing in
 *  src/ reads this beyond the lock statement above. */
export const REMOTE_PATH_ENABLE_LOCK_KEY_FOR_TESTS = REMOTE_PATH_ENABLE_LOCK_KEY;
