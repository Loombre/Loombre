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
// browser-admin-F2: the socket alone is not enough, because a session's
// STATUS changes several times inside one uninterrupted stream (the
// segment-ahead throttle flips a transcode suspended <-> active, a seek
// moves it through `seeking`) and none of those transitions emits an
// event. A periodic refetch (lib/admin-live-refresh.ts — see it for the
// cadence rationale) sits underneath the subscription and keeps every
// row's status pill honest; the socket stays as the low-latency path for
// the start/end transitions it does cover.

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { EmptyState } from "./EmptyState.js";
import { ReasonsPanel } from "./ReasonsPanel.js";
import { StatusPill } from "./StatusPill.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { ADMIN_SESSIONS_REFRESH_MS } from "../../lib/admin-live-refresh.js";
import { describeSessionStatus } from "../../lib/admin-status.js";
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
  const info = describeSessionStatus(session.status);
  const isTranscode = decision === "transcode";

  return (
    <div className={styles.row}>
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
            admin could learn a stream was parked. */}
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

  const refresh = useCallback(() => {
    apiGet("/admin/sessions", { params: { query: { limit: 50 } } })
      .then((page) => setSessions(page.items as AdminSessionWithPlan[]))
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
    return () => {
      debouncedRefresh.cancel();
      unsubStarted();
      unsubEnded();
    };
  }, [refresh]);

  // Status-transition floor (browser-admin-F2): suspended <-> active <->
  // seeking flips emit no event, so nothing above would ever notice them.
  useEffect(() => {
    const timer = setInterval(refresh, ADMIN_SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div>
      <div className={styles.header}>
        <h2 className={styles.title}>Active streams{sessions !== null ? ` · ${sessions.length}` : ""}</h2>
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
