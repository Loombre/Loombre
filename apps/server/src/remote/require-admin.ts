// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/require-admin.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, Wave 0). Every admin op in
// this module (7 controller files, RG15's fan-out split) needs the SAME
// fast-claim-then-fresh-DB-read admin check every existing controller
// re-implements locally (notices.controller.ts / invites.controller.ts /
// catalog/admin.controller.ts / catalog/libraries.controller.ts /
// catalog/users.controller.ts / catalog/data-freedom.controller.ts all
// carry their own copy of this exact function) — extracted ONCE here
// rather than copy-pasted 7 times within this one new module, since every
// caller lives in the same directory (a purely local choice; the existing
// per-controller-file duplication elsewhere is untouched).
//
// requireLiveAdmin re-reads users.is_admin fresh from the DB on every call
// (A10/L2 — never trusts the JWT claim alone, which can be stale for up to
// the access token's lifetime after a demotion); the `req.user?.isAdmin`
// check first is a fast-fail that avoids a wasted DB read on an obviously
// non-admin caller.

import { forbidden } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import type { LoombreDb } from "../common/db.provider.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";

export async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}
