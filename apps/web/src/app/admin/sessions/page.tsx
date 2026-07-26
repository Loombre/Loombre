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

import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Card } from "../../../components/ui/Card.js";
import { Button } from "../../../components/ui/Button.js";
import { Skeleton } from "../../../components/skeleton/Skeleton.js";
import { EmptyState } from "../../../components/admin/EmptyState.js";
import { StatusPill } from "../../../components/admin/StatusPill.js";
import { ReasonsPanel } from "../../../components/admin/ReasonsPanel.js";
import { describeSessionStatus } from "../../../lib/admin-status.js";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import styles from "./page.module.css";

type AdminSession = components["schemas"]["AdminSession"];
// Contract patch c63a420 promoted plan/engineVersion into AdminSession —
// the SDK type carries them directly; the local extension is retired.
type AdminSessionWithPlan = AdminSession;

const PAGE_LIMIT = 50;

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function SessionRow({ session }: { session: AdminSessionWithPlan }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const info = describeSessionStatus(session.status);

  return (
    <div className={styles.row}>
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

  function load(reset: boolean): void {
    if (reset) setLoading(true);
    else setLoadingMore(true);
    apiGet("/admin/sessions", { params: { query: { limit: PAGE_LIMIT, ...(reset ? {} : cursor ? { cursor } : {}) } } })
      .then((page) => {
        const items = page.items as AdminSessionWithPlan[];
        setSessions((prev) => (reset ? items : [...prev, ...items]));
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch((err) => {
        setError(err instanceof LoombreApiError ? err.message : "Failed to load sessions.");
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
