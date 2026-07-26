// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ShellNav } from "./ShellNav.js";
import { Topbar } from "./Topbar.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { apiGet } from "../../lib/api-client.js";
import { BootSplashLazy as BootSplash } from "../brand/BootSplashLazy.js";
import styles from "./AppShell.module.css";

/** Wraps every authenticated route: redirects to /login whenever the store
 *  has no refresh chain — at mount AND for the lifetime of this component,
 *  via a store subscription. That subscription is the fix for a real bug
 *  (STATE.md Wave-2 lane brief): the store can self-clear AFTER mount —
 *  e.g. a background API call's reactive-401 handling calls
 *  store.handleUnauthorized(), which fails and calls store.clear()
 *  (auth-store.ts's refreshNow()) — and the old version of this component
 *  only ever checked isAuthenticated() once in its mount effect, so it kept
 *  rendering (or left a blank page once child fetches started 401ing)
 *  instead of ever navigating away. Subscribing means EVERY state change
 *  re-runs the check, and `ready` flips back to false (unmounting children
 *  immediately, never leaving stale/broken content on screen) the instant
 *  isAuthenticated() goes false, whatever the cause. */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element | null {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  // Phase 4 deliverable D: the ONE admin nav entry in the shell is
  // admin-visible only — sourced from the same /users/me fetch this
  // component already makes for the topbar username, no second request.
  // The Phosphor sidebar (Wave 0) reuses the same fetch for its user row
  // (real display name) and its admin-gated SYSTEM group.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const store = getAuthStore();

    function syncAuth(): void {
      if (store.isAuthenticated()) {
        setReady(true);
      } else {
        setReady(false);
        router.replace("/login");
      }
    }

    syncAuth();
    return store.subscribe(syncAuth);
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    apiGet("/users/me")
      .then((user) => {
        if (cancelled) return;
        setUsername(user.username ?? null);
        setDisplayName(user.displayName ?? null);
        setIsAdmin(user.isAdmin === true);
      })
      .catch(() => {
        if (!cancelled) {
          setUsername(null);
          setDisplayName(null);
          setIsAdmin(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  async function handleSignOut(): Promise<void> {
    await getAuthStore().logout();
    router.replace("/login");
  }

  // STATE.md "Blaze logo rollout" D9: this used to be a blank `return
  // null` for the (usually one-tick) gap before `syncAuth()` resolves —
  // e.g. a hard reload landing directly on an authenticated route, where
  // RootPage (app/page.tsx) never mounts at all. BootSplashLazy shares its
  // one-shot `booted` gate with RootPage's own splash render, so whichever
  // of the two actually mounts first in this tab's lifetime is the only
  // one that ever plays the animation — see BootSplash.tsx's header.
  if (!ready) return <BootSplash />;

  return (
    <div className={styles.shell}>
      {/* ShellNav reads useSearchParams() (the active ?library= for the
          Movies/TV Shows shortcuts' lit state, shared by the desktop
          Sidebar AND the mobile header/tab bar) — Next requires a
          Suspense boundary around that, same pattern app/browse/page.tsx
          already uses for its own useSearchParams() call. Below the
          mobile breakpoint ShellNav's Sidebar is CSS-hidden and its
          MobileHeader/MobileTabBar take over (U2: one component tree,
          CSS decides visibility — see ShellNav.tsx). */}
      <Suspense fallback={null}>
        <ShellNav isAdmin={isAdmin} displayName={displayName} username={username} onSignOut={() => void handleSignOut()} />
      </Suspense>
      {/* Desktop-only chrome (CSS-hidden below the mobile breakpoint;
          MobileHeader replaces it there — see Topbar's own module rule
          in AppShell.module.css). */}
      <Topbar username={username} isAdmin={isAdmin} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
