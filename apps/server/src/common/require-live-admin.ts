// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/require-live-admin.ts
//
// A10 (STATE.md Addendum A) → L2 global closure: every admin authorization
// re-verifies isAdmin with a FRESH server-side DB read at request time —
// never trusted from the access-token claim (`req.user.isAdmin`), which can
// be stale for up to the access token's lifetime (15 minutes, apps/server/
// src/session/token.service.ts) after an admin account is demoted. Mirrors
// apps/server/src/common/viewer-context.provider.ts's gate-5 restricted-
// clearance re-read pattern EXACTLY: that provider never trusts a cached/
// claimed value for a security-sensitive gate either — every resolve()
// call reads user_settings.restricted_unlocked_until_ms fresh from the DB,
// on every request, with no caching layer in between.
//
// History: born in settings/ for the A10 settings surface only, with the
// rest of the admin surfaces recorded as security finding L2 ("authorizes
// off the JWT claim alone"). L2 is now CLOSED globally: the plugins
// services adopted it in the LPP wave, and the catalog admin controllers
// (admin/users/libraries) adopted it in the pre-public hardening pass —
// which is when this file moved to common/, since catalog controllers may
// not import from settings/ (module boundaries; common/ is the established
// escape valve, same as rate-limiter.ts's relocation). The ws-broadcaster
// closes the same gap for admin-only event delivery by re-reading
// users.is_admin at its context-TTL boundary.

import { getUserById } from "@loombre/db";
import type { LoombreDb } from "./db.provider.js";
import { forbidden } from "../gateway/problem.exception.js";

export async function requireLiveAdmin(db: LoombreDb, userId: string, instancePath: string): Promise<void> {
  const user = await getUserById(db, userId);
  if (!user || !user.is_admin) {
    throw forbidden("Admin privileges are required for this operation.", instancePath);
  }
}
