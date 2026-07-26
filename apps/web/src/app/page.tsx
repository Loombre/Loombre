// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// STATE.md P4.6 (lane C) — the boot redirect now checks GET /setup/state
// (via AuthStore.checkNeedsSetup(), cached for the store's lifetime) before
// falling back to /login, so a fresh install lands on the onboarding
// wizard instead of an unusable login form nobody can complete yet. An
// already-authenticated device skips the check entirely (decideBootRoute:
// isAuthenticated always wins -> /home) — a configured, logged-in instance
// pays zero extra network cost.
//
// STATE.md "Blaze logo rollout" D9 — this route used to render a blank
// frame (`return null`) for the duration of the effect above. It now
// renders the boot splash instead (components/brand/BootSplash.tsx,
// dynamically imported via BootSplashLazy.js so its animation code/CSS
// never lands in another route's own first-load chunk — G8). The splash
// owns its own one-shot `booted` gate; it never delays the redirect above
// by even one tick — see BootSplash.tsx's header for why that's true by
// construction, not by convention.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuthStore } from "../lib/auth-store.js";
import { decideBootRoute } from "./setup/wizard-state.js";
import { BootSplashLazy as BootSplash } from "../components/brand/BootSplashLazy.js";

export default function RootPage(): React.JSX.Element {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const store = getAuthStore();

    if (store.isAuthenticated()) {
      router.replace(decideBootRoute({ isAuthenticated: true, needsSetup: false }));
      return;
    }

    void store.checkNeedsSetup().then((needsSetup) => {
      if (cancelled) return;
      router.replace(decideBootRoute({ isAuthenticated: false, needsSetup }));
    });

    return () => {
      cancelled = true;
    };
  }, [router]);
  return <BootSplash />;
}
