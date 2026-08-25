// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/StreamsPanel.tsx
//
// Admin dashboard "ACTIVE STREAMS · n" (Phosphor retheme Wave 2, Lane L2 —
// design/phosphor/README.md "Admin dashboard": "ACTIVE STREAMS · 3 (mode
// badge DIRECT PLAY / TRANSCODE, item, user · device, progress, detail,
// and a WHY: band explaining any transcode)"). Ground-truthed against
// GET /admin/sessions (packages/db/src/query/admin.ts's
// listActiveSessionsAdmin) and reuses its EXACT data + redaction contract
// — the standalone /admin/sessions page's own SessionRow (contentHidden ->
// hidden chip, never a leaked title) and ReasonsPanel (the WHY: band) are
// the source of truth this component mirrors, not a fresh design.
//
// GAP (U9 — never fabricated): the prototype's per-stream "progress" bar
// has NO backing data today. AdminSession (GET /admin/sessions) carries
// no position/duration — `playback_sessions` has no such column, and the
// separate `progress` table is a per-user "continue watching" position,
// not a per-SESSION live one. Logged, not rendered; `n` (the "ACTIVE
// STREAMS · n" count) and every other field below IS real.
//
// Live refresh: subscribes to playback.started/playback.ended over the
// SAME shared events socket JobsPanel/LibrariesPanel already ride (no
// second connection) and refetches on either — never a local
// merge, unlike those two. playback.started/.ended (packages/contract/
// event-schemas/) carry only {sessionId, itemId, deviceId, ...}; they have
// no username/deviceName/plan/contentHidden, so merging one into a row
// would mean fabricating the rest of that row (U9), and only the server's
// listActiveSessionsAdmin applies the P2.8 redaction contract — the client
// must never re-derive it. GAP (U9): playback.* is gated ITEM_ONLY_TYPES
// (packages/db/src/query/events.ts) — an admin not cleared for a
// restricted item never receives that item's start/end event, so this
// live refresh is best-effort for restricted sessions; a row that DOES get
// refetched some other way still renders correctly redacted regardless.
//
// browser-admin-F2: the socket alone was not enough, because a session's
// STATUS changes several times inside one uninterrupted stream (the
// segment-ahead throttle flips a transcode suspended <-> active, a seek
// moves it through `seeking`) and none of those transitions emitted an
// event. A periodic refetch (lib/admin-live-refresh.ts) sat underneath the
// subscription and kept every row's status pill honest.
//
// d3-e5: those transitions now DO emit —
// `playback.session-status-changed`, admin-only, subscribed below. Its
// payload is transport-only (both sides of the move + suspendedByThrottle,
// no itemId/userId/deviceId), which is what makes it the one event this
// panel may fold into a row rather than refetch on: there is nothing
// redaction-bearing in it to re-derive, and — unlike playback.started/.ended
// — nothing ITEM_ONLY_TYPES could withhold from an admin who is not cleared
// for the item, so the U9 gap noted above does not apply to status changes.
// The tick stays as the fallback for what no transition can announce (see
// lib/admin-live-refresh.ts for the relaxed cadence rationale).
//
// d3-e3: "· n" counts LIVE rows, not listed rows. Since browser-admin-F2
// widened the query to every non-terminal status, a walked-away viewer's
// session sits here for ~13.5 minutes (sweeper suspends at 90s, ends at 15
// minutes) — and `suspended` is the SAME enum value the segment-ahead
// throttle writes for a stream someone IS watching. lib/
// admin-session-presence.ts turns the server's suspendedByThrottle/
// heartbeatStale pair into the pill copy and the live/not-live decision;
// stale rows still render (dimmed, "No heartbeat") but never inflate `n`.

import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@loombre/sdk";
import { EmptyState } from "./EmptyState.js";
import { ReasonsPanel } from "./ReasonsPanel.js";
import { StatusPill } from "./StatusPill.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { startAdminSessionsRefresh } from "../../lib/admin-live-refresh.js";
import { countLiveSessions, describeSessionPresence } from "../../lib/admin-session-presence.js";
import {
  mergeSessionStatusChange,
  type PlaybackSessionStatusChangedPayload,
} from "../../lib/admin-session-status-live.js";
import { apiGet } from "../../lib/api-client.js";
import { apiErrorMessage } from "../../lib/api-error-message.js";
import { debounce } from "../../lib/debounce.js";
import { getEventsSocket } from "../../lib/events-socket.js";
import { Video } from "lucide-react";
import styles from "./StreamsPanel.module.css";

type AdminSession = components["schemas"]["AdminSession"];
type AdminSessionWithPlan = AdminSession;

function StreamRow({ session }: { session: AdminSessionWithPlan }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const decision = typeof session.plan?.["decision"] === "string" ? (session.plan!["decision"] as string) : null;
  const info = describeSessionPresence(session);
  const isTranscode = decision === "transcode";

  return (
    // data-live="false" dims the row (StreamsPanel.module.css): it is real,
    // and still actionable, but nobody is on the other end of it.
    <div className={styles.row} data-live={info.live ? "true" : "false"}>
      <div className={styles.main}>
        <span className={styles.modeBadge} data-mode={decision ?? "unknown"}>
          {decision === "transcode" ? "TRANSCODE" : decision === "direct-play" ? "DIRECT PLAY" : info.label.toUpperCase()}
        </span>
        {session.contentHidden ? (
          <span className={styles.hiddenChip}>content hidden</span>
        ) : (
          <span className={styles.itemTitle}>{session.itemTitle ?? "—"}</span>
        )}
        {/* browser-admin-F2: the mode badge describes the PLAN (what was
            decided); this pill describes the session's live STATE. A
            throttle-suspended transcode is both TRANSCODE and Suspended —
            before this, the panel could only say the former, so the
            /admin/sessions page's identical pill was the only place an
            admin could learn a stream was parked. d3-e3: the pill's copy
            now comes from describeSessionPresence, which splits that one
            "Suspended" into the healthy park and the walked-away case. */}
        <StatusPill label={info.label} tone={info.tone} />
      </div>
      <div className={styles.meta}>
        <span>{session.username}</span>
        <span aria-hidden="true">·</span>
        <span>{session.deviceName ?? "unknown device"}</span>
        <span aria-hidden="true">·</span>
        <span>started {new Date(session.startedAtMs).toLocaleTimeString()}</span>
      </div>
      {isTranscode && !session.contentHidden && (
        <button type="button" className={styles.whyToggle} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Hide why" : "Why:"}
        </button>
      )}
      {expanded && <ReasonsPanel plan={session.plan ?? null} contentHidden={session.contentHidden} />}
    </div>
  );
}

export function StreamsPanel(): React.JSX.Element {
  const [sessions, setSessions] = useState<AdminSessionWithPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What is on screen right now, readable from the [] -deps status handler
  // below without making `sessions` a dependency of it (which would tear the
  // socket subscription down and re-arm it on every list change) — the same
  // ref pattern app/admin/sessions/page.tsx uses for its silent refresh.
  const sessionsRef = useRef<AdminSessionWithPlan[] | null>(null);
  sessionsRef.current = sessions;

  const refresh = useCallback(() => {
    apiGet("/admin/sessions", { params: { query: { limit: 50 } } })
      .then((page) => {
        setSessions(page.items as AdminSessionWithPlan[]);
        // d4-e4: the banner describes the CURRENT fetch. Without this, one
        // transient 503 left "Failed to load active streams." above a list
        // that every later tick and socket event kept updating underneath it
        // — permanently, until the admin reloaded the dashboard.
        setError(null);
      })
      .catch((err) => setError(apiErrorMessage(err, "Failed to load active streams.")));
  }, []);

  useEffect(refresh, [refresh]);

  // Live updates — no poll loop while this socket subscription lives, same
  // as every sibling panel on this dashboard (see header for why this
  // refetches instead of merging the event into a row).
  useEffect(() => {
    const socket = getEventsSocket();
    const debouncedRefresh = debounce(refresh, 500);
    const unsubStarted = socket.subscribe("playback.started", () => debouncedRefresh());
    const unsubEnded = socket.subscribe("playback.ended", () => debouncedRefresh());
    // d3-e5: a status transition is the ONE event whose payload carries
    // everything a row needs to change (both sides of the move + the
    // throttle flag, and nothing item-scoped), so it patches the row
    // directly instead of refetching — see lib/admin-session-status-live.ts.
    // A transition for a session this panel does not hold falls back to the
    // same debounced refetch every other event uses.
    const unsubStatus = socket.subscribe<PlaybackSessionStatusChangedPayload>("playback.session-status-changed", (event) => {
      const current = sessionsRef.current;
      const patched = current ? mergeSessionStatusChange(current, event.payload) : null;
      if (patched) setSessions(patched);
      else if (!current || !current.some((s) => s.id === event.payload.sessionId)) debouncedRefresh();
    });
    return () => {
      debouncedRefresh.cancel();
      unsubStarted();
      unsubEnded();
      unsubStatus();
    };
  }, [refresh]);

  // Fallback cadence (browser-admin-F2, relaxed by d3-e5): the subscription
  // above now carries every status transition, so this tick only has to
  // bound how stale a heartbeat-derived fact — `heartbeatStale`, which no
  // transition can announce — is allowed to get. Paused while the tab is
  // hidden, with one refresh on return (d3-e4 — this panel shares the
  // sessions page's tick helper so the two cannot drift apart on cadence or
  // on visibility behaviour).
  useEffect(() => startAdminSessionsRefresh(refresh), [refresh]);

  return (
    <div>
      <div className={styles.header}>
        {/* d3-e3: the count is LIVE rows only. A session nobody has fed a
            heartbeat to in the configured window still lists below (with a
            "No heartbeat" pill), because it exists and an admin may want to
            end it — but claiming it as an active stream is the exact lie
            this finding was filed for. */}
        <h2 className={styles.title}>Active streams{sessions !== null ? ` · ${countLiveSessions(sessions)}` : ""}</h2>
      </div>
      {error && <p className={styles.empty}>{error}</p>}
      {sessions === null ? (
        <div className={styles.list} aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} radius="md" height={64} />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState icon={Video} title="No active sessions" body="Playback sessions from any user will show up here while they're live." />
      ) : (
        <div className={styles.list} role="list" aria-label="Active streams">
          {sessions.map((session) => (
            <StreamRow key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
