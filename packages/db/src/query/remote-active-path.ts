// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-active-path.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2). THE canonical
// resolveActivePath() — replacing every sibling lane's own isolated-
// worktree seam with ONE real cross-subsystem derivation:
//   - WG1's assertNoOtherRemotePathActive no-op
//     (apps/server/src/remote/wireguard/remote-wireguard.service.ts)
//   - T1's RemoteActivePathReader no-op default
//     (apps/server/src/remote/active-path-reader.ts)
//   - D1's WG-only isRemoteWireguardActive check
//     (src/query/remote-direct.ts, this same package)
//   - S1's honestly-always-'none' posture reader
//     (apps/server/src/remote/posture/active-path.reader.ts)
// All four now delegate to resolveActivePath below (apps/server's own
// binding lives at apps/server/src/remote/remote-active-path.service.ts).
//
// RG15: "at most one of remote/tunnel/direct can be enabled at a time."
// This function is the LAST line of defense proving that invariant, not
// the mechanism that enforces it — if it ever observes MORE than one
// subsystem reporting enabled=true simultaneously, that is a correctness
// bug elsewhere, and this function refuses to silently pick one and move
// on: it logs loudly (console.error, matching apps/server/src/gateway/
// problem-json.filter.ts's own "structured, single-line, server-side-only"
// convention for an unanticipated condition) and throws
// RemoteActivePathInvariantViolationError, which the exception filter turns
// into a real 500 problem+json response — visibly broken, never masked.
//
// LD-9 UPDATE: the mechanism that enforces the invariant is now
// src/query/remote-path-guard.ts's withRemotePathEnableGuard, applied
// inside all three enable writers. The per-flow 409 pre-checks in
// apps/server remain as a fail-fast optimization, no longer as the
// enforcement. This resolver and that guard read the three `enabled` bits
// through the SAME function (readRemotePathFlags) so the thing that
// enforces the invariant and the thing that reports its violation can
// never disagree about what "enabled" means.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import { readRemotePathFlags, type RemoteActivePathFlags } from './remote-path-guard.js';
import { type RemotePathId } from './remote-direct.js';

/** Thrown by deriveActivePath (and therefore resolveActivePath) when more
 *  than one of the three remote-access subsystems reports enabled=true at
 *  once — see this file's header for why this is a loud failure rather
 *  than a silently-resolved one. */
export class RemoteActivePathInvariantViolationError extends Error {
  constructor(public readonly enabledPaths: readonly RemotePathId[]) {
    super(
      `RG15 invariant violation: ${enabledPaths.length} remote-access paths report enabled simultaneously (${enabledPaths.join(', ')}) — at most one may ever be active. This should be impossible by construction (each path's staged enable flow checks resolveActivePath before committing); refusing to mask it by picking one.`,
    );
    this.name = 'RemoteActivePathInvariantViolationError';
  }
}

/** Defined in src/query/remote-path-guard.ts (which owns readRemotePathFlags,
 *  the one reader both this resolver and the enable guard use) and re-exported
 *  here so the public barrel's existing export path is unchanged. */
export type { RemoteActivePathFlags };

/** Pure — the actual derivation table (8 combinations of the three
 *  subsystems' own `enabled` booleans), no I/O. resolveActivePath below is
 *  the impure wrapper that reads the three live rows and calls this. */
export function deriveActivePath(flags: RemoteActivePathFlags): RemotePathId {
  const enabledPaths: RemotePathId[] = [];
  if (flags.remote) enabledPaths.push('remote');
  if (flags.tunnel) enabledPaths.push('tunnel');
  if (flags.direct) enabledPaths.push('direct');

  if (enabledPaths.length > 1) {
    // BELIEVED UNREACHABLE (LD-9 closed V-SEC F2 — this comment used to read
    // "KNOWN LIMITATION" and describe the live race that produced this state).
    //
    // WHY it is now believed unreachable: every write that sets one of these
    // three `enabled` bits to true goes through enableRemoteWireguardAndEmit /
    // enableTunnelStateAndEmit / enableRemoteDirectStateAndEmit, and all three
    // run their row write inside withRemotePathEnableGuard (src/query/
    // remote-path-guard.ts) — ONE transaction that first takes a shared
    // transaction-scoped advisory lock and then re-reads all three bits under
    // it. Two concurrent enables of different paths therefore serialize, and
    // the second one sees the first's committed row and rejects with
    // RemotePathConflictError instead of committing. The old race window (a
    // non-transactional check-then-commit spanning a multi-second Cloudflare
    // provisioning call) no longer exists: the check and the commit are the
    // same transaction. See that module's design note for the full argument,
    // including why the lock cannot be left held.
    //
    // WHY the throw stays anyway: "believed", not "proven". Reaching this
    // branch now requires a writer that bypasses this package's three enable
    // functions entirely — direct SQL against the state rows, a restored
    // backup that was already inconsistent, or a future FOURTH remote path
    // whose author forgot the guard. Each of those is exactly the case where
    // silently picking one path would be worse than a loud 500, so the
    // defense-in-depth response is unchanged.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'remote_active_path_invariant_violation',
        enabledPaths,
        message: 'more than one remote-access path reports enabled simultaneously — RG15 invariant violated',
        timestamp: new Date().toISOString(),
      }),
    );
    throw new RemoteActivePathInvariantViolationError(enabledPaths);
  }

  return enabledPaths[0] ?? 'none';
}

/** THE canonical resolver (RG15/WG2): reads remote_wireguard_state,
 *  remote_tunnel_state, and the Direct path's internal state row and
 *  derives the single active path. Takes NO lock and is never called from
 *  inside the enable guard's critical section — reads and the disable
 *  flows must never be blocked by an enable in flight (LD-9 design note
 *  §7). */
export async function resolveActivePath(db: Kysely<DB>): Promise<RemotePathId> {
  return deriveActivePath(await readRemotePathFlags(db));
}
