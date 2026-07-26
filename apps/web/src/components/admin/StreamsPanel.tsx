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

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { EmptyState } from "./EmptyState.js";
import { ReasonsPanel } from "./ReasonsPanel.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import { describeSessionStatus } from "../../lib/admin-status.js";
import { apiGet, LoombreApiError } from "../../lib/api-client.js";
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

  useEffect(() => {
    apiGet("/admin/sessions", { params: { query: { limit: 50 } } })
      .then((page) => setSessions(page.items as AdminSessionWithPlan[]))
      .catch((err) => setError(err instanceof LoombreApiError ? err.message : "Failed to load active streams."));
  }, []);

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
