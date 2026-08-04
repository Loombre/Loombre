// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/NoticeHistoryPanel.tsx
//
// Settings -> Notices, panel (e): every notice ever published, newest
// first — InvitesPanel.tsx is the direct template (hairline-separated
// panel below the cards above it, NOT itself a boxed Card; rows carry a
// severity pill + status pill + truncated message + who/when; "Load more"
// when the parent's cursor says there's another page). All fetch/mutation
// state (including pagination) lives in the parent NoticesSection — this
// component is purely presentational plus the one "Load more" callback.

import { History } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { StatusPill } from "../../admin/StatusPill.js";
import { EmptyState } from "../../admin/EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { describeNoticeSeverity, describeNoticeStatus, shortUuid, truncateMessage } from "./notice-display.js";
import sharedStyles from "./shared.module.css";
import styles from "./NoticesSection.module.css";

type SystemNoticeAdmin = components["schemas"]["SystemNoticeAdmin"];

export function NoticeHistoryPanel({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  /** null while the first page hasn't resolved yet. */
  items: SystemNoticeAdmin[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.historyPanel}>
      <div className={sharedStyles.header}>
        <h2 className={sharedStyles.title}>
          History{items !== null && <span className={sharedStyles.countMono}> · {items.length}</span>}
        </h2>
      </div>

      {items === null ? (
        <div className={sharedStyles.skeletonList} aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} radius="md" height={56} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={History}
          title="No notices yet"
          body="Published notices — active, cancelled, or expired — will appear here."
        />
      ) : (
        <div className={sharedStyles.list}>
          {items.map((notice) => {
            const severityInfo = describeNoticeSeverity(notice.severity);
            const statusInfo = describeNoticeStatus(notice.status);
            return (
              <div key={notice.id} className={sharedStyles.row}>
                <div className={sharedStyles.rowMain}>
                  <div className={sharedStyles.rowText}>
                    <span className={sharedStyles.rowTitle} title={notice.message}>
                      {truncateMessage(notice.message)}
                    </span>
                    <span className={sharedStyles.rowSub}>
                      <span title={notice.createdBy ?? undefined}>
                        {notice.createdBy ? shortUuid(notice.createdBy) : "removed user"}
                      </span>{" "}
                      · {new Date(notice.createdAtMs).toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className={sharedStyles.rowChips}>
                  <StatusPill label={severityInfo.label} tone={severityInfo.tone} />
                  <StatusPill label={statusInfo.label} tone={statusInfo.tone} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasMore && (
        <div className={styles.loadMoreRow}>
          <Button type="button" variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
