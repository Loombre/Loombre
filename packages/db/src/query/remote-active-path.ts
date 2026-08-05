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
// RG15: "at most one of remote/tunnel/direct can be enabled at a time,
// enforced by each path's staged enable flow returning 409 against another
// active path." This function is the LAST line of defense proving that
// invariant, not the mechanism that enforces it (the 409 checks at each
// staged enable flow are) — if it ever observes MORE than one subsystem
// reporting enabled=true simultaneously, that is a correctness bug
// elsewhere (a 409 check that should have prevented this got bypassed, or
// raced), and this function refuses to silently pick one and move on: it
// logs loudly (console.error, matching apps/server/src/gateway/
// problem-json.filter.ts's own "structured, single-line, server-side-only"
// convention for an unanticipated condition) and throws
// RemoteActivePathInvariantViolationError, which the exception filter turns
// into a real 500 problem+json response — visibly broken, never masked.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import { getRemoteWireguardState } from './remote-wireguard.js';
import { getRemoteTunnelState } from './remote-tunnel.js';
import { getRemoteDirectInternalState, type RemotePathId } from './remote-direct.js';

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

export interface RemoteActivePathFlags {
  remote: boolean;
  tunnel: boolean;
  direct: boolean;
}

/** Pure — the actual derivation table (8 combinations of the three
 *  subsystems' own `enabled` booleans), no I/O. resolveActivePath below is
 *  the impure wrapper that reads the three live rows and calls this. */
export function deriveActivePath(flags: RemoteActivePathFlags): RemotePathId {
  const enabledPaths: RemotePathId[] = [];
  if (flags.remote) enabledPaths.push('remote');
  if (flags.tunnel) enabledPaths.push('tunnel');
  if (flags.direct) enabledPaths.push('direct');

  if (enabledPaths.length > 1) {
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
 *  remote_tunnel_state, and the Direct path's internal state row (all
 *  three already have their own getter in this package — see each
 *  module's own header) and derives the single active path. */
export async function resolveActivePath(db: Kysely<DB>): Promise<RemotePathId> {
  const [wireguard, tunnel, direct] = await Promise.all([
    getRemoteWireguardState(db),
    getRemoteTunnelState(db),
    getRemoteDirectInternalState(db),
  ]);
  return deriveActivePath({
    remote: wireguard.enabled,
    tunnel: tunnel.enabled,
    direct: direct.enabled,
  });
}
