// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-active-path.service.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2 — the integration
// unification STATE.md explicitly assigns this lane: "implement ONE real
// resolver... bind T1's RemoteActivePathReader token to it (replace
// Noop)"). Thin binding: this class's only job is to satisfy the
// RemoteActivePathReader abstract-class DI token (active-path-reader.ts)
// by delegating to the canonical @loombre/db resolveActivePath()
// (packages/db/src/query/remote-active-path.ts), which does the real
// cross-subsystem read + derivation.
//
// remote.module.ts binds `{ provide: RemoteActivePathReader, useClass:
// RemoteActivePathResolverService }`, replacing WG1/T1's
// NoopRemoteActivePathReader default — every consumer of the token
// (RemoteTunnelService's own 409 check, RemoteWireguardService's
// assertNoOtherRemotePathActive, RemoteDirectController's 409 check, and
// RemoteStateController's getRemoteState composition) now sees the SAME
// real derivation with zero call-site changes beyond this one binding.

import { Injectable } from "@nestjs/common";
import { resolveActivePath } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import { RemoteActivePathReader, type RemotePathId } from "./active-path-reader.js";

@Injectable()
export class RemoteActivePathResolverService implements RemoteActivePathReader {
  constructor(private readonly dbProvider: DbProvider) {}

  async activePath(): Promise<RemotePathId> {
    return resolveActivePath(this.dbProvider.db);
  }
}
