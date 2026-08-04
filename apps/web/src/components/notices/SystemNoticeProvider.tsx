// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/notices/SystemNoticeProvider.tsx
//
// STATE.md NG9: the ONE state owner for system notices, mounted inside
// AppProviders (survives route remounts — the same reason
// RestrictedProvider/MusicPlayerProvider live there; see that file's own
// header) so a notice published mid-navigation is never lost and a
// warning banner doesn't reset itself on every route change.
//
// Sources of truth, per NG2/NG3/NG10:
//   - a boot fetch of GET /notices/active once authenticated, following an
//     auth-store subscription (RestrictedProvider's own pattern for its
//     optIn load) — this file never calls socket connect()/disconnect()
//     itself, AppProviders' header reserves that lifecycle exclusively.
//   - live `notice.published`/`notice.cancelled` over the shared events
//     socket (NG1: zero new server plumbing — an all-user broadcast
//     already reaches every authenticated socket).
//   - a refetch on every socket reconnect (`onStatusChange` -> "open",
//     NG2's "late-connect = the REST read" reconciliation), which ALSO
//     clears any per-session dismiss so a still-active warning returns
//     (N3: "returns on next connect while active").
//
// Per-session dismiss is in-memory ONLY (component state) — the app has
// deliberately zero sessionStorage (NG10) and this keeps it that way.
//
// The clock anchor (NG3) is always a SERVER timestamp: `serverNowMs` from
// the REST read, or the envelope's `tsMs` from a socket event — never this
// client's own wall clock alone. See notice-time.ts for the pure math.
//
// Lifecycle rules (mission): auto-clear locally at expiresAtMs via a
// timer, never a poll; on active-fetch FAILURE keep showing whatever is
// already held (a server mid-restart must not blank the "restarting now"
// banner); on active-fetch success with `notice: null`, clear. Info
// severity fires the existing single-slot toast once per notice id,
// including when the notice arrives via the boot fetch (N2: late-
// connecting users must see it too).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import { useToast } from "../ui/Toast.js";
import { computeServerOffsetMs } from "./notice-time.js";

export type SystemNotice = components["schemas"]["SystemNotice"];
export type NoticeSeverity = components["schemas"]["NoticeSeverity"];

interface NoticeState {
  notice: SystemNotice | null;
  serverOffsetMs: number;
  /** The id of the notice the user has dismissed THIS session, or null.
   *  Only ever meaningful for the notice currently held — see `dismissed`
   *  in the context value below. */
  dismissedId: string | null;
}

const initialState: NoticeState = { notice: null, serverOffsetMs: 0, dismissedId: null };

export interface SystemNoticeContextValue {
  notice: SystemNotice | null;
  severity: NoticeSeverity | null;
  serverOffsetMs: number;
  /** Whether the CURRENT notice has been dismissed this session. Always
   *  false once `notice` is null or has a different id than what was
   *  dismissed. */
  dismissed: boolean;
  dismiss: () => void;
  /** warning/critical, currently held, not dismissed — the ONE signal
   *  BannerRegion (and SettingsRestartBanner's precedence check, N6)
   *  need; consumers stay dumb. */
  bannerVisible: boolean;
}

const SystemNoticeContext = createContext<SystemNoticeContextValue | null>(null);

interface CancelledPayload {
  id: string;
}

export function SystemNoticeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<NoticeState>(initialState);
  const { showToast } = useToast();
  // Info-severity notices toast once per id (N2: "including when the
  // notice arrives via the boot fetch"). Tracked outside `state` because a
  // toast is a one-time EVENT, not a rendering of state — a reconnect
  // refetch (or a redundant boot re-fetch across an auth-store tick) that
  // returns the SAME still-active info notice must never re-toast it.
  const toastedIdsRef = useRef<Set<string>>(new Set());

  const maybeToastInfo = useCallback(
    (notice: SystemNotice | null) => {
      if (!notice || notice.severity !== "info" || toastedIdsRef.current.has(notice.id)) return;
      toastedIdsRef.current.add(notice.id);
      showToast(notice.message, { variant: "accent" });
    },
    [showToast],
  );

  const applyActive = useCallback(
    (notice: SystemNotice | null, serverAnchorMs: number) => {
      const offset = computeServerOffsetMs(serverAnchorMs);
      setState((prev) => ({ ...prev, notice, serverOffsetMs: offset }));
      maybeToastInfo(notice);
    },
    [maybeToastInfo],
  );

  // Staleness guard (review finding R-F1): a GET /notices/active response
  // is a SNAPSHOT taken when the request started — if a socket
  // notice.published/notice.cancelled lands while the fetch is in flight
  // (or a newer fetch starts), the resolving snapshot is stale and must be
  // DISCARDED, or it clobbers/resurrects over the newer truth and sticks
  // until the next event. The triggering condition — a slow
  // /notices/active while the server is mid-restart — is this feature's
  // primary scenario. Mechanism: a monotonic generation, bumped by every
  // fetch START and every socket-event application; a fetch only applies
  // its result if the generation is unchanged since it began.
  const stateGenRef = useRef(0);

  const fetchActive = useCallback(async (): Promise<void> => {
    const gen = ++stateGenRef.current;
    try {
      const res = await apiGet("/notices/active");
      if (stateGenRef.current !== gen) return; // superseded mid-flight (R-F1)
      applyActive(res.notice, res.serverNowMs);
    } catch {
      // Active-fetch failure keeps showing whatever is already held — a
      // server mid-restart must not blank the "restarting now" banner.
    }
  }, [applyActive]);

  // Boot fetch, gated on auth exactly like RestrictedProvider's optIn
  // load: an auth-store subscription, never a socket connect/disconnect
  // call of our own.
  useEffect(() => {
    let cancelled = false;
    const store = getAuthStore();

    async function run(): Promise<void> {
      if (!store.isAuthenticated() || cancelled) return;
      await fetchActive();
    }

    void run();
    const unsubAuth = store.subscribe(() => void run());
    return () => {
      cancelled = true;
      unsubAuth();
    };
  }, [fetchActive]);

  // Live delivery + reconnect reconciliation.
  useEffect(() => {
    const socket = getEventsSocket();

    const unsubPublished = socket.subscribe<SystemNotice>("notice.published", (event: EventEnvelope<SystemNotice>) => {
      stateGenRef.current++; // invalidate any in-flight active fetch (R-F1)
      const payload = event.payload;
      const offset = computeServerOffsetMs(event.tsMs);
      setState((prev) => ({
        notice: payload,
        serverOffsetMs: offset,
        // A publish REPLACES whatever is held (v1's single-active-notice
        // model, NG8: no cancelled event fires for the row it supersedes)
        // and re-arms visibility for the new id.
        dismissedId: prev.dismissedId === payload.id ? prev.dismissedId : null,
      }));
      maybeToastInfo(payload);
    });

    const unsubCancelled = socket.subscribe<CancelledPayload>("notice.cancelled", (event: EventEnvelope<CancelledPayload>) => {
      // Bump UNCONDITIONALLY — even a cancel for an id we don't currently
      // hold invalidates an in-flight fetch, because that fetch may be
      // about to apply exactly the notice this event just cancelled
      // (the resurrect-a-ghost variant of R-F1).
      stateGenRef.current++;
      setState((prev) => (prev.notice && prev.notice.id === event.payload.id ? { ...prev, notice: null } : prev));
    });

    // Reconnect reconciliation (NG2): a socket that connects after a batch
    // is marked processed never catches up via the socket itself, so
    // re-fetch the REST truth on every transition to "open" — including
    // the very first connect, which is harmless (dismissedId is already
    // null then). N3: "a dismissed warning returns on next connect while
    // active" — the dismiss flag clears unconditionally on reconnect,
    // ahead of whatever the fetch finds.
    const unsubStatus = socket.onStatusChange((status) => {
      if (status !== "open") return;
      setState((prev) => (prev.dismissedId === null ? prev : { ...prev, dismissedId: null }));
      void fetchActive();
    });

    return () => {
      unsubPublished();
      unsubCancelled();
      unsubStatus();
    };
  }, [fetchActive, maybeToastInfo]);

  // Local expiry timer (not a poll): auto-clears once offset-corrected now
  // passes expiresAtMs. `expiresAtMs === null` means "until cancelled"
  // (legal only for critical, NG4) — no timer needed then.
  useEffect(() => {
    const notice = state.notice;
    if (!notice || notice.expiresAtMs === null) return undefined;
    const targetId = notice.id;
    const expiresAtMs = notice.expiresAtMs;
    const clear = (): void => {
      setState((prev) => (prev.notice && prev.notice.id === targetId ? { ...prev, notice: null } : prev));
    };
    const delay = expiresAtMs - (Date.now() + state.serverOffsetMs);
    if (delay <= 0) {
      clear();
      return undefined;
    }
    // setTimeout's delay is internally a 32-bit signed int — clamp so an
    // unusually-far expiry never wraps into firing immediately.
    const timer = setTimeout(clear, Math.min(delay, 0x7fffffff));
    return () => clearTimeout(timer);
  }, [state.notice, state.serverOffsetMs]);

  const dismiss = useCallback(() => {
    setState((prev) => (prev.notice ? { ...prev, dismissedId: prev.notice.id } : prev));
  }, []);

  const value = useMemo<SystemNoticeContextValue>(() => {
    const dismissed = state.notice !== null && state.dismissedId === state.notice.id;
    const severity = state.notice?.severity ?? null;
    const bannerVisible = state.notice !== null && !dismissed && (severity === "warning" || severity === "critical");
    return {
      notice: state.notice,
      severity,
      serverOffsetMs: state.serverOffsetMs,
      dismissed,
      dismiss,
      bannerVisible,
    };
  }, [state, dismiss]);

  return <SystemNoticeContext.Provider value={value}>{children}</SystemNoticeContext.Provider>;
}

export function useSystemNotice(): SystemNoticeContextValue {
  const ctx = useContext(SystemNoticeContext);
  if (!ctx) throw new Error("useSystemNotice() called outside <SystemNoticeProvider>");
  return ctx;
}

/** Non-throwing twin of useSystemNotice(), for the ONE consumer
 *  (SettingsRestartBanner.tsx) that lives inside components owned by a
 *  different lane running in parallel on the same base (STATE.md FILE
 *  OWNERSHIP) — this file can't safely require every one of THEIR call
 *  sites/tests to also wrap in <SystemNoticeProvider>. Falls back to "no
 *  active notice" (fail toward SHOWING the restart-pending banner, never
 *  toward hiding it) when rendered outside the provider; every real route
 *  always has one (AppProviders), so this only matters in isolation. */
export function useSystemNoticeOptional(): SystemNoticeContextValue | null {
  return useContext(SystemNoticeContext);
}
