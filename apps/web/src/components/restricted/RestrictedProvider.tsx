// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedProvider.tsx
//
// P2.8 restricted-content UX state, shared app-wide via context so the
// shell's lock control (components/shell/RestrictedLockControl.tsx, my
// file per lane ownership) and the PIN modal stay in sync with each other
// and with the websocket instantly.
//
// Lock-state honesty note (REWRITTEN — browser-restricted-settings-F3 /
// browser-items-F3, 2026-08-21 QA): this file used to note that the
// contract had NO GET returning {optIn, hasPin, unlockedUntilMs} and
// defaulted to locked/hasPin-unknown on every mount, arguing that gate 5
// "never persists across logins" made locked the server-verified truth.
// That premise did not survive contact with the server: gate 5 is
// re-verified on EVERY request from user_settings.restricted_unlocked_
// until_ms (apps/server/src/common/viewer-context.provider.ts), a row that
// a full-page reload does not touch — so a reload inside a live unlock
// window showed a "locked" header indicator while the zone kept rendering,
// and a PIN holder who had not unlocked in THIS page session got
// first-time-opt-in UI at /profile (hasPin null hides the Current PIN field
// and blocks a blank "keep current PIN" save). The spec gap is now closed:
// GET /users/me/restricted returns exactly that triple, and the bootstrap
// below hydrates from it. Defaults stay locked/unknown until it answers —
// a failed or in-flight bootstrap never fails open. From there:
//   - a successful POST /restricted/unlock gives an exact unlockedUntilMs
//     (self-timed locally, no polling needed)
//   - explicit POST /restricted/lock flips to locked immediately
//   - websocket `restricted.locked`/`restricted.unlocked` (both delivered
//     ONLY to this user's own sockets server-side) flip the OTHER tabs'/
//     devices' state instantly; `restricted.unlocked` carries no expiry, so
//     that case applies the server's documented 30-minute TTL (STATE.md
//     P2.1 "restricted-unlock (5/min/user)... 30-min TTL") as a clearly-
//     labeled ESTIMATE for the countdown UI — the server re-verifies gate 5
//     itself on every request regardless of what this estimate says, so a
//     stale estimate is a UX-only staleness, never a security issue.
// If the websocket is down, this degrades to "assume locked" (fail closed)
// per the task's instruction — never fails open.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { apiGet, apiPost, LoombreApiError } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import { emitCatalogInvalidation } from "../../lib/catalog-invalidation.js";

/** Matches the server's RESTRICTED_UNLOCK_DURATION_MS
 *  (apps/server/src/session/restricted.controller.ts) — used only as the
 *  ESTIMATE for a cross-tab/device `restricted.unlocked` event that carries
 *  no expiry of its own; see header. */
const ASSUMED_UNLOCK_TTL_MS = 30 * 60 * 1000;
const SELF_EXPIRY_CHECK_INTERVAL_MS = 5_000;

export interface RestrictedState {
  loading: boolean;
  optIn: boolean;
  /** null = unknown — only before the mount bootstrap below has answered
   *  (or after it failed / while signed out). Consumers that offer a
   *  PIN-holder-only affordance MUST treat null as "not yet known", never
   *  as false: components/profile/ProfileSettings.tsx's Restricted card
   *  keys its Current-PIN field and its blank-PIN "keep current" save on
   *  this exact value. */
  hasPin: boolean | null;
  unlockedUntilMs: number | null;
  locked: boolean;
  modalOpen: boolean;
  submitting: boolean;
  error: string | null;
}

export interface RestrictedContextValue {
  state: RestrictedState;
  openUnlockModal: () => void;
  closeUnlockModal: () => void;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => Promise<void>;
  /** For the settings page: called after a successful PUT /users/me/restricted. */
  applyRestrictedSettings: (optIn: boolean, hasPin: boolean) => void;
}

const RestrictedContext = createContext<RestrictedContextValue | null>(null);

const initialState: RestrictedState = {
  loading: true,
  optIn: false,
  hasPin: null,
  unlockedUntilMs: null,
  locked: true,
  modalOpen: false,
  submitting: false,
  error: null,
};

interface RestrictedLockedPayload {
  userId: string;
}
interface RestrictedUnlockedPayload {
  userId: string;
}

export function RestrictedProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<RestrictedState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback((partial: Partial<RestrictedState>) => {
    setState((prev) => {
      const next = { ...prev, ...partial };
      next.locked = next.unlockedUntilMs === null || next.unlockedUntilMs <= Date.now();
      return next;
    });
  }, []);

  // Bootstrap: hydrate the WHOLE restricted triple (opt-in, PIN presence,
  // live unlock expiry) from GET /users/me/restricted once authenticated,
  // and again on every auth-store change (sign-in/out, token refresh).
  // Never blocks the UI on failure — restricted stays locked/opted-out/
  // hasPin-unknown, i.e. fail closed, exactly as before this endpoint
  // existed.
  //
  // Deliberately does NOT emitCatalogInvalidation() when the hydrate flips
  // the client to unlocked: the server never consulted the client's flag in
  // the first place (gate 5 is re-verified per request), so everything
  // fetched during this same mount is already correct — invalidating here
  // would re-fetch every mounted list on every page load inside an unlock
  // window for no new data. The unlock()/lock()/websocket paths below still
  // invalidate, because those are real state TRANSITIONS.
  useEffect(() => {
    let cancelled = false;
    const store = getAuthStore();

    async function loadRestricted(): Promise<void> {
      if (!store.isAuthenticated()) {
        if (!cancelled) patch({ loading: false });
        return;
      }
      try {
        const restricted = await apiGet("/users/me/restricted");
        if (cancelled) return;
        patch({
          optIn: restricted.optIn,
          hasPin: restricted.hasPin,
          // Already null-ed server-side when elapsed; patch() re-derives
          // `locked` from it against the local clock regardless.
          unlockedUntilMs: restricted.unlockedUntilMs,
          loading: false,
        });
      } catch {
        if (!cancelled) patch({ loading: false });
      }
    }

    void loadRestricted();
    const unsubAuth = store.subscribe(() => void loadRestricted());
    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, [patch]);

  // RZI-D5c zone subscription: the server delivers restricted-item events
  // only to sockets that opened it, so restricted `item.added` toasts (and
  // every other restricted-item envelope) can never surface while the
  // viewer is on a general page — even inside a live unlock window. Driven
  // by the route: on inside /restricted, off everywhere else; the socket
  // itself re-arms the frame after reconnects (events-socket.ts).
  const pathname = usePathname();
  useEffect(() => {
    const socket = getEventsSocket();
    // pathname is null outside a router (jsdom component tests mount this
    // provider bare); null is never inside the zone.
    const inZone = pathname !== null && (pathname === "/restricted" || pathname.startsWith("/restricted/"));
    socket.setRestrictedZoneSubscribed(inZone);
    return () => socket.setRestrictedZoneSubscribed(false);
  }, [pathname]);

  // Websocket: instant cross-tab/device lock/unlock + self-expiry ticking.
  useEffect(() => {
    const socket = getEventsSocket();
    const unsubLocked = socket.subscribe<RestrictedLockedPayload>("restricted.locked", (_e: EventEnvelope<RestrictedLockedPayload>) => {
      patch({ unlockedUntilMs: null });
      emitCatalogInvalidation();
    });
    const unsubUnlocked = socket.subscribe<RestrictedUnlockedPayload>("restricted.unlocked", (_e: EventEnvelope<RestrictedUnlockedPayload>) => {
      // Own-tab unlocks already set an exact unlockedUntilMs synchronously
      // in unlock() below; this branch mainly serves OTHER tabs/devices of
      // the same user, where an estimate is the best available signal.
      patch({ unlockedUntilMs: Date.now() + ASSUMED_UNLOCK_TTL_MS });
      emitCatalogInvalidation();
    });

    const selfExpiryTimer = setInterval(() => {
      const s = stateRef.current;
      if (s.unlockedUntilMs !== null && s.unlockedUntilMs <= Date.now()) {
        patch({ unlockedUntilMs: null });
        emitCatalogInvalidation();
      }
    }, SELF_EXPIRY_CHECK_INTERVAL_MS);

    return () => {
      unsubLocked();
      unsubUnlocked();
      clearInterval(selfExpiryTimer);
    };
  }, [patch]);

  const openUnlockModal = useCallback(() => patch({ modalOpen: true, error: null }), [patch]);
  const closeUnlockModal = useCallback(() => patch({ modalOpen: false, error: null }), [patch]);

  const unlock = useCallback(
    async (pin: string): Promise<boolean> => {
      patch({ submitting: true, error: null });
      try {
        const result = await apiPost("/restricted/unlock", { body: { pin } });
        patch({ unlockedUntilMs: result.unlockedUntilMs, hasPin: true, submitting: false, modalOpen: false });
        emitCatalogInvalidation();
        return true;
      } catch (err) {
        let message = "Could not unlock restricted content.";
        if (err instanceof LoombreApiError) {
          if (err.status === 401) message = "Incorrect PIN.";
          else if (err.status === 429) message = "Too many attempts — try again shortly.";
          else if (err.status === 403) message = "Restricted content isn't enabled for your account.";
        }
        patch({ submitting: false, error: message });
        return false;
      }
    },
    [patch],
  );

  const lock = useCallback(async (): Promise<void> => {
    patch({ unlockedUntilMs: null }); // optimistic — the explicit-lock affordance should feel instant
    emitCatalogInvalidation();
    try {
      await apiPost("/restricted/lock");
    } catch {
      // The self-expiry/WS paths will reconcile if this best-effort call
      // failed to actually reach the server; the client is already locked
      // either way (fail closed, never fail open).
    }
  }, [patch]);

  const applyRestrictedSettings = useCallback((optIn: boolean, hasPin: boolean) => patch({ optIn, hasPin }), [patch]);

  const value = useMemo<RestrictedContextValue>(
    () => ({ state, openUnlockModal, closeUnlockModal, unlock, lock, applyRestrictedSettings }),
    [state, openUnlockModal, closeUnlockModal, unlock, lock, applyRestrictedSettings],
  );

  return <RestrictedContext.Provider value={value}>{children}</RestrictedContext.Provider>;
}

export function useRestricted(): RestrictedContextValue {
  const ctx = useContext(RestrictedContext);
  if (!ctx) throw new Error("useRestricted() called outside <RestrictedProvider>");
  return ctx;
}
