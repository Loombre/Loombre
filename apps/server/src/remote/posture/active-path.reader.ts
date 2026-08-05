// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/active-path.reader.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7/RG15, S1 lane; WG2 integration
// unification wires the real derivation — see below).
//
// S1's ORIGINAL ADJUDICATION (kept for history): R7's card needs to know
// the active path to pick which checks apply (posture-model.ts's
// applicableChecks). RG15's law is that activePath is DERIVED from the
// three subsystems' own enabled state, never stored — but on S1's own
// isolated Batch-1 worktree, none of WG1's/T1's/Direct's persisted state
// existed yet, so the truthful answer was unconditionally 'none'. S1 left
// this as a real, swappable seam (same pattern as
// ConnectorHealthReaderService/WireguardStatusReaderService) specifically
// so integration could replace this class's one method with ONE canonical
// resolveActivePath() helper both this reader and RemoteStateController
// call — flagged in S1's own report as future integration work.
//
// WG2 (this lane, STATE.md's own assignment: "make S1's posture active-
// path reader delegate to it, preserve S1's test seams per its file-header
// notes") closes that extraction: `read()` now delegates to @loombre/db's
// resolveActivePath() (packages/db/src/query/remote-active-path.ts), the
// SAME canonical resolver RemoteStateController/RemoteTunnelService/
// RemoteDirectController/RemoteWireguardService all now use via the
// RemoteActivePathReader token (apps/server/src/remote/
// remote-active-path.service.ts). TEST SEAM PRESERVED: remote-posture.
// service.spec.ts never goes through Nest DI for this class at all — it
// constructs RemotePostureService directly with a hand-rolled
// `{ read: () => Promise<T> }` fake cast to this type (see that file's
// `fakeReader` helper), so this class's real implementation is never
// exercised by that suite; only apps/server/test/remote-posture.e2e.spec.ts
// (the full-DI-stack e2e) exercises the wired instance, and it never
// enables any path itself, so its own "empty checks[] on a fresh DB"
// assertion holds unchanged (deriveActivePath('none') on a fresh reseeded
// DB is still 'none', exactly as before).

import { Injectable } from "@nestjs/common";
import { resolveActivePath } from "@loombre/db";
import type { PostureActivePath } from "@loombre/shared";
import { DbProvider } from "../../common/db.provider.js";

@Injectable()
export class RemoteActivePathReaderService {
  constructor(private readonly dbProvider: DbProvider) {}

  async read(): Promise<PostureActivePath> {
    return resolveActivePath(this.dbProvider.db);
  }
}
