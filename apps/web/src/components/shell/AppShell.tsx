// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ShellNav } from "./ShellNav.js";
import { Topbar } from "./Topbar.js";
import { BannerRegion } from "./BannerRegion.js";
import { SessionEndedNotice } from "./SessionEndedNotice.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { apiGet } from "../../lib/api-client.js";
import {
  AUTH_REDIRECT_FALLBACK_MS,
  buildLoginHref,
  currentLocationPath,
  hardRedirect,
} from "../../lib/auth-return-path.js";
import { BootSplashLazy as BootSplash } from "../brand/BootSplashLazy.js";
import { useSystemNotice } from "../notices/SystemNoticeProvider.js";
import styles from "./AppShell.module.css";

/** Three states, not one boolean (browser-shell-browse-F1): "we haven't
 *  decided yet" and "the session is gone" used to share `ready === false`,
 *  and they need OPPOSITE screens — a splash for the first, an exit for
 *  the second. */
type AuthPhase = "pending" | "ready" | "lost";

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
 *  re-runs the check, and the phase leaves "ready" (unmounting children
 *  immediately, never leaving stale/broken content on screen) the instant
 *  isAuthenticated() goes false, whatever the cause.
 *
 *  browser-shell-browse-F1 (2026-08-20/21 QA) is the SECOND half of that
 *  bug: unmounting the children is necessary but not sufficient. Leaving
 *  "ready" used to mean rendering <BootSplash/>, which is a dead end once
 *  auth is gone — the splash either freezes (it claimed the one-shot and
 *  nothing ever unmounts it) or renders literally nothing (the one-shot was
 *  already claimed, so BootSplash returns null: a blank document, no <main>,
 *  no link, no retry). Both were observed for as long as the tab stayed
 *  open, because the router.replace('/login') that should have ended the
 *  state had silently not committed. So a lost session now has its OWN
 *  terminal screen (SessionEndedNotice) plus three independent ways out,
 *  weakest dependency last: router.replace → a hard document navigation
 *  after AUTH_REDIRECT_FALLBACK_MS → a plain <a href> the user can click. */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element | null {
  const router = useRouter();
  const [authPhase, setAuthPhase] = useState<AuthPhase>("pending");
  const [loginHref, setLoginHref] = useState("/login");
  // Set by handleSignOut so the store-cleared notification it triggers can
  // tell a DELIBERATE sign-out from a session that died under the user:
  // only the latter gets a return path (nobody who just signed out of
  // /profile wants their next sign-in to land back on /profile).
  const signingOut = useRef(false);
  const ready = authPhase === "ready";
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  // Phase 4 deliverable D: the ONE admin nav entry in the shell is
  // admin-visible only — sourced from the same /users/me fetch this
  // component already makes for the topbar username, no second request.
  // The Phosphor sidebar (Wave 0) reuses the same fetch for its user row
  // (real display name) and its admin-gated SYSTEM group.
  const [isAdmin, setIsAdmin] = useState(false);
  // BannerRegion (NG9) needs its own margin to clear the fixed topbar;
  // <main>'s ordinary topbar-clearance padding would then double it up
  // when a banner is actually showing — see AppShell.module.css's
  // `[data-banner="true"]` override and BannerRegion.module.css's header.
  const { bannerVisible } = useSystemNotice();

  useEffect(() => {
    const store = getAuthStore();

    function syncAuth(): void {
      if (store.isAuthenticated()) {
        setAuthPhase("ready");
        return;
      }
      // Terminal: the store only ever clears itself on a DEFINITIVE 401
      // from POST /auth/refresh or on an explicit logout (auth-store.ts
      // keeps the credential across transient 429/5xx/network failures),
      // so there is nothing to wait for here — this session is over.
      const href = signingOut.current ? "/login" : buildLoginHref(currentLocationPath());
      setLoginHref(href);
      setAuthPhase("lost");
      router.replace(href);
    }

    syncAuth();
    return store.subscribe(syncAuth);
  }, [router]);

  // browser-shell-browse-F1: the router.replace above is the FAST path, not
  // a guarantee. QA caught it not committing (an intermittent Next-dev
  // render/compile stall) and the app then sat on a dead screen for as long
  // as the tab was open. If we are still mounted and still signed out after
  // AUTH_REDIRECT_FALLBACK_MS, stop trusting client-side navigation and do
  // a full document load — which cannot be swallowed by whatever stalled
  // the router. A healthy replace unmounts this component first, clearing
  // the timer before it ever fires.
  useEffect(() => {
    if (authPhase !== "lost") return;
    const timer = setTimeout(() => hardRedirect(loginHref), AUTH_REDIRECT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [authPhase, loginHref]);

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
    // Flagged BEFORE logout(): clear() notifies subscribers synchronously,
    // so syncAuth runs inside this await and must already know this is a
    // deliberate exit (bare /login, no return path).
    signingOut.current = true;
    await getAuthStore().logout();
    router.replace("/login");
  }

  // browser-shell-browse-F1: this MUST come before the splash. The splash
  // is a "wait, we're deciding" screen; a lost session is a decision, and
  // rendering BootSplash for it produced the two dead screens QA filmed —
  // a frozen splash (first mount in the tab: the animation plays and then
  // nothing ever ends it) or a blank document (any later mount: BootSplash's
  // one-shot `booted` gate returns null), in both cases with no text, no
  // link and no retry once the /login navigation failed to commit.
  if (authPhase === "lost") return <SessionEndedNotice loginHref={loginHref} />;

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
      <BannerRegion />
      <main className={styles.main} data-banner={bannerVisible}>
        {children}
      </main>
    </div>
  );
}
