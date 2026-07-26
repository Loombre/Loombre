// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/require-live-admin.ts
//
// A10 (STATE.md Addendum A): every settings mutation re-verifies isAdmin
// with a FRESH server-side DB read at mutation time — never trusted from
// the access-token claim (`req.user.isAdmin`), which can be stale for up to
// the access token's lifetime (15 minutes, apps/server/src/session/
// token.service.ts) after an admin account is demoted. Mirrors apps/server/
// src/common/viewer-context.provider.ts's gate-5 restricted-clearance
// re-read pattern EXACTLY: that provider never trusts a cached/claimed
// value for a security-sensitive gate either — every resolve() call reads
// user_settings.restricted_unlocked_until_ms fresh from the DB, on every
// request, with no caching layer in between.
//
// SECURITY FINDING POINTER (L2, carried from Phase 4's security review):
// every OTHER admin mutation in this codebase today (e.g. apps/server/src/
// catalog/admin.controller.ts's own requireAdmin(), and its siblings across
// the catalog/libraries/users controllers) still authorizes off the JWT
// claim alone, with no live re-read. This function is offered as the
// pattern the REST of those call sites should adopt once that closure work
// is scheduled — see this lane's final report ("L2 partially remediated:
// settings surface only, global closure is a separate task", matching
// STATE.md's own Addendum A precondition-reconciliation note). Closing L2
// globally is explicitly OUT OF SCOPE for this lane.

import { getUserById } from "@loombre/db";
import type { LoombreDb } from "../common/db.provider.js";
import { forbidden } from "../gateway/problem.exception.js";

export async function requireLiveAdmin(db: LoombreDb, userId: string, instancePath: string): Promise<void> {
  const user = await getUserById(db, userId);
  if (!user || !user.is_admin) {
    throw forbidden("Admin privileges are required for this operation.", instancePath);
  }
}
