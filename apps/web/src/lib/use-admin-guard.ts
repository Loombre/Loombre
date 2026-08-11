// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/use-admin-guard.ts
//
// opus-review LD wave, Finding 6: the "GET /users/me -> redirect a
// non-admin away" UX guard existed as FOUR hand-copied implementations
// (SettingsShell.tsx, app/admin/layout.tsx, apps/web/src/app/settings/
// plugins/[id]/PluginDetailScreen.tsx, and AppShell.tsx's own admin-nav
// visibility fetch) — this extracts the THREE that are genuinely the same
// "redirect-away route guard" shape into one hook. AppShell's isAdmin read
// is deliberately NOT unified here: it never redirects (isAdmin there only
// toggles whether one nav item renders) and it shares its fetch with the
// SAME GET /users/me call that resolves username/displayName for the
// topbar — a materially different shape, not a copy of this one.
//
// This is UX only, same posture every call site's own header already
// documents: the real security boundary is server-side (every admin
// endpoint independently 403s a non-admin token) — a client-side bypass of
// this hook could see loading skeletons or a flash of admin-only chrome at
// worst, never real data a non-admin token's requests wouldn't also be
// refused for.
//
// `redirectTo` is a parameter, not hardcoded, because the three call sites
// disagree on where a non-admin lands: SettingsShell.tsx and
// PluginDetailScreen.tsx both go to /profile ("every /settings* route
// bounces a non-admin to /profile" — section-registry.ts's header),
// app/admin/layout.tsx goes to /home (/admin/* has no "your own" landing
// page to fall back to the way /settings* does).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "./api-client.js";

export interface UseAdminGuardResult {
  /** `null` while GET /users/me is still resolving (nothing is known yet
   *  — callers should render nothing, or a neutral loading shape, but
   *  never admin-only content). `true` once confirmed admin. `false` once
   *  confirmed NOT admin (including a GET /users/me failure, which fails
   *  closed the same way every one of the three call sites already did
   *  independently) — by the time this is `false`, `router.replace
   *  (redirectTo)` has already been called. */
  isAdmin: boolean | null;
}

/**
 * One GET /users/me, one redirect-on-non-admin effect. Callers still own
 * their OWN render branching on the returned `isAdmin` (null vs. true vs.
 * false render very differently across the three sites — a bare `return
 * null` for SettingsShell/PluginDetailScreen vs. app/admin/layout.tsx
 * keeping its AppShell chrome mounted throughout the check) — this hook
 * only centralizes the fetch + redirect side effect, not the JSX.
 */
export function useAdminGuard(redirectTo: string): UseAdminGuardResult {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet("/users/me")
      .then((u) => {
        if (!cancelled) setIsAdmin(u.isAdmin === true);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isAdmin === false) router.replace(redirectTo);
  }, [isAdmin, router, redirectTo]);

  return { isAdmin };
}
