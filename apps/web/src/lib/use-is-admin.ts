// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/use-is-admin.ts
//
// QA 2026-08-21 browser-casual-F1: the "is this viewer an admin?" read
// that a NON-route component needs in order to hide an admin-only
// affordance. Deliberately NOT useAdminGuard (use-admin-guard.ts): that
// hook is a route guard — it `router.replace(redirectTo)`s a non-admin
// away, which is exactly wrong for a viewer who is legitimately on the
// page and merely must not see one button. AppShell.tsx holds the same
// flag for the shell's admin nav entry, but keeps it in local state with
// no context to read it from, and it is not this component's ancestor in
// any testable sense — so a content component that needs the flag makes
// its own read here rather than a fourth hand-copied `apiGet("/users/me")
// .then((u) => u.isAdmin === true)`.
//
// SECURITY POSTURE (same as every other client-side admin check in this
// app): this is UX only. The real boundary is server-side — every
// /admin/* endpoint independently 403s a non-admin token (requireAdmin).
// Faking `true` here reveals a button whose requests are still refused.
//
// Fail-closed by construction: `null` until GET /users/me answers, and
// `false` if it rejects. Callers render admin-only chrome only on `true`,
// so nothing ever flashes during the in-flight window.

import { useEffect, useState } from "react";
import { apiGet } from "./api-client.js";

/**
 * `null` while GET /users/me is in flight (nothing known yet), `true` once
 * confirmed admin, `false` once confirmed non-admin OR on any failure.
 * Never redirects — see this file's header for why that is the point.
 */
export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet("/users/me")
      .then((user) => {
        if (!cancelled) setIsAdmin(user.isAdmin === true);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
