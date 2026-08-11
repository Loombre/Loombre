// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/NoticesSection.tsx
//
// Settings -> Notices (admin-only, section-registry.ts's "notices" key) —
// mission §3 Lane B: admin broadcast notices (system_notices, N1-N6).
// Composes three pieces on ONE shared data source:
//   a. ActiveNoticeCard  — the current active notice + cancel.
//   b. ComposeNoticeCard — publish, with presets + replace-confirm.
//   e. NoticeHistoryPanel — the full cursor-paginated history.
//
// ONE fetch of GET /system/notices' first page serves all three: the
// active notice is derived client-side as `items.find(status==="active")`
// (NG4/N1: exactly one ACTIVE notice can exist at a time, and the list is
// createdAtMs-desc, so the active row — if any — is always in the first
// page) rather than a second round-trip to GET /notices/active. `refresh`
// is the single choke point every mutation (publish/cancel) and the live
// socket handlers below call — nothing else re-fetches independently.
//
// Live refresh (N2/NG9, "optional but cheap"): subscribes to
// notice.published/notice.cancelled on the shared events socket
// (read-only use of lib/events-socket.ts — never modified by this lane)
// and just calls `refresh()`, ignoring the event payload entirely (the
// payload is the all-user SystemNotice shape, which deliberately excludes
// the admin-only fields — createdBy/status/cancelledAtMs — this surface
// needs, so re-fetching the real admin list is the only honest source).

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet, LoombreApiError } from "../../../lib/api-client.js";
import { getEventsSocket } from "../../../lib/events-socket.js";
import { ActiveNoticeCard } from "./ActiveNoticeCard.js";
import { ComposeNoticeCard } from "./ComposeNoticeCard.js";
import { NoticeHistoryPanel } from "./NoticeHistoryPanel.js";
import styles from "./NoticesSection.module.css";

type SystemNoticeAdmin = components["schemas"]["SystemNoticeAdmin"];

const HISTORY_PAGE_LIMIT = 20;

export function NoticesSection({ heading }: { heading: string | null }): React.JSX.Element {
  const [items, setItems] = useState<SystemNoticeAdmin[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiGet("/system/notices", { params: { query: { limit: HISTORY_PAGE_LIMIT } } })
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof LoombreApiError ? err.message : "Failed to load notices."));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const socket = getEventsSocket();
    const unsubPublished = socket.subscribe("notice.published", () => refresh());
    const unsubCancelled = socket.subscribe("notice.cancelled", () => refresh());
    return () => {
      unsubPublished();
      unsubCancelled();
    };
  }, [refresh]);

  function loadMore(): void {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    apiGet("/system/notices", { params: { query: { cursor: nextCursor, limit: HISTORY_PAGE_LIMIT } } })
      .then((page) => {
        setItems((prev) => (prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => setError(err instanceof LoombreApiError ? err.message : "Failed to load more notices."))
      .finally(() => setLoadingMore(false));
  }

  const activeNotice = items?.find((n) => n.status === "active") ?? null;

  return (
    <div className={styles.page}>
      {heading !== null && <h1 className={styles.heading}>{heading}</h1>}

      {/* LD-4 (owner QA, 2026-08-10): copy moved VERBATIM out of
          ComposeNoticeCard's own `.note` — it belongs to the whole page,
          not just the compose form, and the page should open with it. */}
      <p className={styles.intro}>
        Notices are shown to every user on this server — never include restricted-zone references or personal
        information. A notice is communication only: publishing one does not restart, shut down, or otherwise change
        anything on the server by itself (use Settings → Server for that).
      </p>

      <ActiveNoticeCard notice={activeNotice} loading={items === null} onChanged={refresh} />

      <ComposeNoticeCard activeNotice={activeNotice} activeNoticeLoaded={items !== null} onPublished={refresh} />

      {error && <p className={styles.errorBanner}>{error}</p>}

      <NoticeHistoryPanel items={items} hasMore={nextCursor !== null} loadingMore={loadingMore} onLoadMore={loadMore} />
    </div>
  );
}
