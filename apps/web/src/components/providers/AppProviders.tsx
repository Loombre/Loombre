// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/providers/AppProviders.tsx
//
// Mounted once in the ROOT layout (apps/web/src/app/layout.tsx), ABOVE
// Next's per-route layout boundary. This is deliberate, not incidental:
// AppShell (shell-owned) is re-instantiated by every page.tsx individually
// (`<AppShell>{content}</AppShell>` per route, not a shared layout — see
// AppShell.tsx), so nothing rendered inside it survives navigation. Two
// things this lane owns MUST survive navigation: the music mini player's
// real <audio> elements (a route change must not interrupt playback) and
// the restricted-unlock/websocket state (P2.8: instant relock across the
// whole app, not just the current route). Both need a mount point above
// that per-route remount boundary — the root layout is the only one that
// qualifies, hence this component and the ~3-line edit to layout.tsx that
// wraps `{children}` with it.
//
// Also owns the shared events-socket lifecycle: connects once authenticated
// (subscribing to the AuthStore so login/logout toggle it), disconnects on
// logout. Nothing else in the app should call events-socket connect/
// disconnect directly.

import { useEffect, type ReactNode } from "react";
import { getAuthStore } from "../../lib/auth-store.js";
import { getEventsSocket } from "../../lib/events-socket.js";
import { loadAndApplyAppearancePrefs } from "../../lib/appearance-prefs.js";
import { RestrictedProvider } from "../restricted/RestrictedProvider.js";
import { PinModal } from "../restricted/PinModal.js";
import { MusicPlayerProvider } from "../music/MusicPlayerProvider.js";
import { MiniPlayerBar } from "../music/MiniPlayerBar.js";
import { QueueDrawer } from "../music/QueueDrawer.js";
import { ToastProvider } from "../ui/Toast.js";

function EventsSocketLifecycle(): null {
  useEffect(() => {
    const store = getAuthStore();
    const socket = getEventsSocket();

    function sync(): void {
      if (store.isAuthenticated()) socket.connect();
      else socket.disconnect();
    }

    sync();
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      socket.disconnect();
    };
  }, []);
  return null;
}

/** Wave 2 L7: applies the persisted accent/scanlines preference (client-
 *  only — see lib/appearance-prefs.ts's header for why there's no server
 *  round-trip yet) as root-level attributes ONCE, before anything below
 *  renders content that reads --color-accent/--scanlines. Same "no
 *  attribute needed for the default" design as that file's own functions —
 *  a fresh browser with nothing in localStorage writes nothing to the DOM
 *  here either, so this effect is a no-op for the common case. */
function AppearancePrefsLifecycle(): null {
  useEffect(() => {
    loadAndApplyAppearancePrefs();
  }, []);
  return null;
}

export function AppProviders({ children }: { children: ReactNode }): React.JSX.Element {
  // ToastProvider is OUTERMOST (Wave-1 reconciliation): every Wave-2 flow
  // toasts, including ones living beside {children} here (PinModal relock
  // notices, mini-player actions) — nothing may sit outside its reach.
  return (
    <ToastProvider>
      <RestrictedProvider>
        <MusicPlayerProvider>
          <AppearancePrefsLifecycle />
          <EventsSocketLifecycle />
          {children}
          <MiniPlayerBar />
          <QueueDrawer />
          <PinModal />
        </MusicPlayerProvider>
      </RestrictedProvider>
    </ToastProvider>
  );
}
