// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/sessions/page.tsx
//
// Phase 4 deliverable D: GET /admin/sessions with the P2.8 redaction
// rendered honestly (a restricted session this admin isn't cleared to see
// still appears — id/user/device/status are never restricted content —
// with itemTitle null and a visible "content hidden" chip, never silently
// dropped) plus the reasons view (ReasonsPanel, per row, expandable).
//
// `plan`/`engineVersion` are additive wire fields beyond the frozen (this
// wave) AdminSession SDK type — AdminSessionWithPlan widens it locally
// rather than waiting on next wave's contract promotion (see
// apps/server/src/catalog/admin.controller.ts's header for the full
// discovered-gap writeup this mirrors).
//
// Live refresh: subscribes to playback.started/playback.ended over the
// shared events socket (StreamsPanel.tsx's header has the full reasoning —
// refetch page 1 rather than merge, since neither event payload carries
// the fields a row needs and only the server applies the P2.8 redaction
// contract). Silent — it does not flip `loading`, so an admin watching
// this page never sees the skeleton re-flash for a background nudge.
//
// browser-admin-F2: the same silent refetch also ran on a periodic tick
// (lib/admin-live-refresh.ts), because the status transitions this page
// exists to show — the segment-ahead throttle's suspended <-> active flip,
// `seeking` during a seek — emitted no event at all, so a socket-only page
// froze on whatever status was true at mount.
//
// d3-e5: they emit now (`playback.session-status-changed`, admin-only), and
// this page patches the affected row from the event's own payload —
// including a row on a "Load more" page, which the page-1 refetch could
// never have reached. The tick remains underneath at a relaxed cadence for
// what an event cannot carry (see lib/admin-live-refresh.ts).
//
// d4-e2: and that tick now re-reads EVERY loaded page (bounded by
// SILENT_REFRESH_MAX_PAGES), not just page 1 — otherwise the pages d3-e4
// taught it to keep were kept forever without ever being corrected, and
// `heartbeatStale`, the one fact no transition can announce, could sit wrong
// on a page-2 row until the admin reloaded.
//
// d3-e3: each row's pill comes from lib/admin-session-presence.ts, which
// splits the one `suspended` enum value into the throttle's healthy park
// ("Buffered ahead") and a session nothing has been heard from ("No
// heartbeat", dimmed) using the server's suspendedByThrottle/heartbeatStale
// fields. The "heartbeat <time>" meta line below is the raw evidence behind
// that pill and predates it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Video } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Card } from "../../../components/ui/Card.js";
import { Button } from "../../../components/ui/Button.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { EmptyState } from "../../../components/admin/EmptyState.js";
import { StatusPill } from "../../../components/admin/StatusPill.js";
import { ReasonsPanel } from "../../../components/admin/ReasonsPanel.js";
import { startAdminSessionsRefresh } from "../../../lib/admin-live-refresh.js";
import { mergeAdminSessionFirstPage } from "../../../lib/admin-session-merge.js";
import { describeSessionPresence } from "../../../lib/admin-session-presence.js";
import {
  mergeSessionStatusChange,
  type PlaybackSessionStatusChangedPayload,
} from "../../../lib/admin-session-status-live.js";
import { apiGet } from "../../../lib/api-client.js";
import { apiErrorMessage } from "../../../lib/api-error-message.js";
import { debounce } from "../../../lib/debounce.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import styles from "./page.module.css";

type AdminSession = components["schemas"]["AdminSession"];
// Contract patch c63a420 promoted plan/engineVersion into AdminSession —
// the SDK type carries them directly; the local extension is retired.
type AdminSessionWithPlan = AdminSession;

const PAGE_LIMIT = 50;

/** d4-e2: how many of the admin's LOADED pages one silent refresh re-reads.
 *  A ceiling on the tick's cost, not a target — the walk stops at the first
 *  null cursor, so a page an admin never opened is never fetched. Past this
 *  many "Load more" presses the deeper rows keep the retention behaviour
 *  d3-e4 gave them (kept, untouched) rather than growing the tick without
 *  bound: mergeAdminSessionFirstPage preserves everything older than the
 *  last row this walk actually read. */
const SILENT_REFRESH_MAX_PAGES = 5;

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function SessionRow({ session }: { session: AdminSessionWithPlan }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // d3-e3: the pill separates the throttle's healthy park from a session
  // nothing has been heard from — `suspended` alone cannot say which.
  const info = describeSessionPresence(session);

  return (
    <div className={styles.row} data-live={info.live ? "true" : "false"}>
      <button type="button" className={styles.rowHeader} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <div className={styles.rowMain}>
          <span className={styles.username}>{session.username}</span>
          {session.contentHidden ? (
            <span className={styles.hiddenChip}>content hidden</span>
          ) : (
            <span className={styles.itemTitle}>{session.itemTitle ?? "—"}</span>
          )}
          <StatusPill label={info.label} tone={info.tone} />
        </div>
        <div className={styles.rowMeta}>
          <span className={styles.metaItem}>{session.deviceName ?? "unknown device"}</span>
          <span className={styles.metaItem}>started {formatTime(session.startedAtMs)}</span>
          <span className={styles.metaItem}>heartbeat {formatTime(session.lastHeartbeatMs)}</span>
        </div>
      </button>
      {expanded && (
        <div className={styles.expandedPanel}>
          <ReasonsPanel plan={session.plan ?? null} contentHidden={session.contentHidden} />
        </div>
      )}
    </div>
  );
}

export default function AdminSessionsPage(): React.JSX.Element {
  const [sessions, setSessions] = useState<AdminSessionWithPlan[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What is on screen RIGHT NOW, readable from the [] -deps silent refresh
  // below without making `sessions` a dependency of it (which would tear
  // down and re-arm the socket subscription and the tick on every list
  // change). Assigned during render, so it is current at commit time.
  const sessionsRef = useRef<AdminSessionWithPlan[]>([]);
  sessionsRef.current = sessions;

  // d4-e2: how many keyset pages are ON SCREEN — the silent refresh re-reads
  // exactly that many (capped), so "Load more" widens what the tick keeps
  // honest instead of leaving those rows frozen.
  const loadedPagesRef = useRef(1);
  // Bumped by every load() and every silent refresh, so a walk whose pages
  // arrive after a newer read cannot apply stale rows over fresh ones.
  const refreshSeqRef = useRef(0);
  useEffect(() => () => void (refreshSeqRef.current += 1), []);

  function load(reset: boolean): void {
    if (reset) setLoading(true);
    else setLoadingMore(true);
    refreshSeqRef.current += 1;
    apiGet("/admin/sessions", { params: { query: { limit: PAGE_LIMIT, ...(reset ? {} : cursor ? { cursor } : {}) } } })
      .then((page) => {
        const items = page.items as AdminSessionWithPlan[];
        setSessions((prev) => (reset ? items : [...prev, ...items]));
        loadedPagesRef.current = reset ? 1 : loadedPagesRef.current + 1;
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, "Failed to load sessions."));
        setLoading(false);
        setLoadingMore(false);
      });
  }

  useEffect(() => {
    // One-time initial load. `load` itself is recreated every render and
    // reads `cursor` fresh from state, so the "load more" button always
    // calls the current closure — an empty deps array here is correct.
    load(true);
  }, []);

  // A silent refetch of what is on screen, distinct from `load` (which flips
  // `loading` and would re-show the full skeleton on every session
  // start/end). Shared by the socket subscription and the periodic tick below
  // (browser-admin-F2).
  //
  // d3-e4: it MERGES page 1 in rather than replacing the list. It used to
  // `setSessions(page.items)` outright, which silently discarded every
  // "Load more" page within one 10s tick whenever more than PAGE_LIMIT
  // sessions were live. lib/admin-session-merge.ts owns the rule (page 1 is
  // authoritative for its own keyset window and says nothing below it); the
  // cursor is only re-adopted when nothing was kept beyond that window,
  // because otherwise the existing cursor — which continues after the last
  // row actually on screen — is the correct one.
  //
  // d4-e2: it walks EVERY loaded page, not just page 1. d3-e4 stopped the
  // tick discarding a "Load more" page; the residual was that it then never
  // refreshed one either, and `heartbeatStale` is derived per REQUEST — no
  // transition fires when a client simply stops sending heartbeats (that is
  // the whole reason this tick outlived d3-e5's event), so a page-2 row could
  // claim a live viewer indefinitely. The walk re-reads from the TOP through
  // the current cursors rather than replaying the ones "Load more" used: that
  // is self-correcting when sessions start or end underneath, and produces
  // exactly the rows "Load more" would produce now.
  const refreshLoadedPagesSilently = useCallback((): void => {
    const seq = (refreshSeqRef.current += 1);
    void (async () => {
      try {
        const pages = Math.min(loadedPagesRef.current, SILENT_REFRESH_MAX_PAGES);
        const items: AdminSessionWithPlan[] = [];
        let pageCursor: string | null = null;
        let complete = false;
        for (let page = 0; page < pages; page += 1) {
          // Annotated: apiGet's result type derives from its argument and
          // `pageCursor` is assigned back out of that result (TS7022).
          const query: { limit: number; cursor?: string } =
            pageCursor === null ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor: pageCursor };
          // Sequential by necessity — each page needs the previous cursor.
          const result = await apiGet("/admin/sessions", { params: { query } });
          if (refreshSeqRef.current !== seq) return;
          items.push(...(result.items as AdminSessionWithPlan[]));
          pageCursor = result.nextCursor;
          complete = pageCursor === null;
          if (complete) break;
        }
        const merged = mergeAdminSessionFirstPage(sessionsRef.current, items, { complete });
        setSessions(merged);
        // Nothing survived beyond the window this walk just read, so the
        // walk's own trailing cursor is the one that continues the list. When
        // rows WERE kept (deeper than SILENT_REFRESH_MAX_PAGES), the existing
        // cursor already points past them and this one would re-fetch what is
        // on screen.
        if (merged.length === items.length) {
          loadedPagesRef.current = Math.max(1, Math.min(pages, Math.ceil(items.length / PAGE_LIMIT)));
          setCursor(pageCursor);
          setHasMore(pageCursor !== null);
        }
      } catch {
        // A live nudge failing silently is fine — the page already has a
        // committed snapshot on screen; an error banner here would be
        // noisier than useful for a background refresh.
      }
    })();
  }, []);

  // d3-e5: a status transition patches its row where it stands, from the
  // event's own payload (lib/admin-session-status-live.ts) — never through
  // the page-1 refetch above, which by construction says nothing about the
  // rows "Load more" fetched. A transition for a session this page does not
  // hold is the one case that still needs the server.
  const applyStatusChange = useCallback((payload: PlaybackSessionStatusChangedPayload): boolean => {
    const patched = mergeSessionStatusChange(sessionsRef.current, payload);
    if (patched) {
      setSessions(patched);
      return true;
    }
    return sessionsRef.current.some((session) => session.id === payload.sessionId);
  }, []);

  useEffect(() => {
    const socket = getEventsSocket();
    const debouncedRefresh = debounce(refreshLoadedPagesSilently, 500);
    const unsubStarted = socket.subscribe("playback.started", () => debouncedRefresh());
    const unsubEnded = socket.subscribe("playback.ended", () => debouncedRefresh());
    const unsubStatus = socket.subscribe<PlaybackSessionStatusChangedPayload>("playback.session-status-changed", (event) => {
      if (!applyStatusChange(event.payload)) debouncedRefresh();
    });
    return () => {
      debouncedRefresh.cancel();
      unsubStarted();
      unsubEnded();
      unsubStatus();
    };
  }, [refreshLoadedPagesSilently, applyStatusChange]);

  // Fallback cadence (browser-admin-F2, relaxed by d3-e5): the subscription
  // above now covers every status transition, so this tick is left only with
  // what no transition can announce — `heartbeatStale`, derived per request
  // — plus anything a dropped socket missed. Paused while the tab is hidden,
  // with one refresh on return (d3-e4).
  useEffect(() => startAdminSessionsRefresh(refreshLoadedPagesSilently), [refreshLoadedPagesSilently]);

  return (
    <Card>
      <div className={styles.header}>
        <h2 className={styles.title}>Sessions</h2>
        <span className={styles.subtitle}>Active playback across every user — now-playing presence</span>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}

      {loading ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton radius="sm" width={120} height={16} />
              <Skeleton radius="pill" width={80} height={20} />
              <Skeleton radius="sm" width="30%" height={12} />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState icon={Video} title="No active sessions" body="Playback sessions from any user will show up here while they're live." />
      ) : (
        <>
          <div className={styles.list} role="list" aria-label="Active sessions">
            {sessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </div>
          {hasMore && (
            <div className={styles.loadMoreRow}>
              <Button variant="secondary" onClick={() => load(false)} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
