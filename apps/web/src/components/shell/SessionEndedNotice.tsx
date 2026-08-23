// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/SessionEndedNotice.tsx
//
// browser-shell-browse-F1 (2026-08-20/21 QA, P2): what an authenticated
// route renders once its session is definitively gone — the state that used
// to be a frozen boot splash or, once BootSplash's one-shot `booted` gate
// had been claimed, a literally empty document with no way out but a manual
// reload (see AppShell.test.tsx's header for both manifestations).
//
// Two jobs, in this order:
//   1. SAY something. A dead screen is a bug; a screen that states what
//      happened is a recovery. It is a live region so a screen reader
//      hears the session end even though nothing was focused.
//   2. Offer a link that WORKS EVEN IF THE ROUTER DOESN'T. This is a plain
//      <a>, deliberately NOT next/link: the failure mode that produced the
//      QA screenshots is a client-side navigation that never commits, so
//      the manual escape hatch has to be an ordinary full document load
//      that cannot be swallowed by the same stall. AppShell keeps issuing
//      the router.replace (fast path) and arms a hard-navigation timer
//      behind it; this link is the third, always-available layer.
//
// Brand chrome comes from the shared AuthScreen (the /login, /forgot,
// /reset, /claim shell) so a lost session looks like the sign-in surface
// it is about to become, rather than half-rendered app furniture.

import { AuthScreen } from "../auth/AuthScreen.js";
import styles from "./SessionEndedNotice.module.css";

export function SessionEndedNotice({ loginHref }: { loginHref: string }): React.JSX.Element {
  return (
    <AuthScreen>
      <div className={styles.notice} role="status" aria-live="polite" data-testid="session-ended">
        {/* Copy that is true in BOTH ways this screen is reached: a session
            that died mid-use, and a fresh tab opened straight onto an
            authenticated URL with no stored session at all. It also names
            the affordance, because the whole reason this screen exists is
            that the automatic navigation is not guaranteed to arrive. */}
        <div className={styles.heading}>Signed out</div>
        <p className={styles.body}>Taking you to the sign-in screen. If nothing happens, use the button below.</p>
        <a className={styles.action} href={loginHref}>
          Sign in
        </a>
      </div>
    </AuthScreen>
  );
}
