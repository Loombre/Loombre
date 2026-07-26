// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedProvider.tsx
//
// P2.8 restricted-content UX state, shared app-wide via context so the
// shell's lock control (components/shell/RestrictedLockControl.tsx, my
// file per lane ownership) and the PIN modal stay in sync with each other
// and with the websocket instantly.
//
// Lock-state honesty note: the contract has NO GET endpoint that returns
// {optIn, hasPin, unlockedUntilMs} — only PUT /users/me/restricted (mutates
// AND returns it) and POST /restricted/unlock (returns unlockedUntilMs
// only). This is a genuine spec gap (documented in the wave report). This
// provider works around it correctly rather than around it badly: gate 5
// "unlock state never persists across logins" (openapi.yaml's
// /restricted/unlock description) means LOCKED is the server-verified truth
// immediately after every fresh auth — so defaulting to locked on mount is
// not a guess, it is the actual state. From there:
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
  /** null = unknown (never learned from a PUT response yet in this session). */
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

  // Load restrictedOptIn (the one field a GET endpoint actually exposes —
  // UserSettings.restrictedOptIn) once authenticated. Never blocks the UI on
  // failure — restricted defaults to locked/opted-out either way.
  useEffect(() => {
    let cancelled = false;
    const store = getAuthStore();

    async function loadOptIn(): Promise<void> {
      if (!store.isAuthenticated()) {
        if (!cancelled) patch({ loading: false });
        return;
      }
      try {
        const settings = await apiGet("/users/me/settings");
        if (!cancelled) patch({ optIn: settings.restrictedOptIn, loading: false });
      } catch {
        if (!cancelled) patch({ loading: false });
      }
    }

    void loadOptIn();
    const unsubAuth = store.subscribe(() => void loadOptIn());
    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, [patch]);

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
