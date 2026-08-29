// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/JobsPanel.tsx
//
// Phase 4 deliverable D: the admin Jobs list, extracted (Phosphor retheme
// Wave 2, Lane L2) out of app/admin/jobs/page.tsx so the SAME component
// backs both the standalone /admin/jobs page AND the new /admin dashboard's
// collapsible job-queue panel — "existing admin/jobs... surfaces reflowed,
// not rebuilt", not a second copy of the live-merge logic. GET /admin/jobs
// seeds a cursor-paged, newest-first list (Job schema); every `job.updated`
// event received over the shared events websocket (admin-only delivery,
// apps/server/src/gateway/ws-broadcaster.service.ts's ADMIN_ONLY_TYPES)
// updates a row IN PLACE via the pure mergeJobUpdate (lib/admin-jobs-live.ts)
// — no poll loop runs while the socket lives, per the task brief.
// `progress` is carried ONLY by the live event (the Job REST resource has
// no such field), so it's tracked in a SEPARATE map keyed by jobId,
// live-only, cleared when a job leaves active/queued.

import { useCallback, useEffect, useState } from "react";
import { Briefcase } from "lucide-react";
import { Skeleton } from "../skeleton/Skeleton.js";
import { EmptyState } from "./EmptyState.js";
import { StatusPill } from "./StatusPill.js";
import { VirtualList } from "./VirtualList.js";
import { describeJobStatus } from "../../lib/admin-status.js";
import { formatRelativeTime } from "../../lib/relative-time.js";
import { mergeJobUpdate, type Job, type JobUpdatedPayload } from "../../lib/admin-jobs-live.js";
import { apiGet } from "../../lib/api-client.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import { apiErrorCopy } from "../../lib/api-error-message.js";
import styles from "./JobsPanel.module.css";

const PAGE_LIMIT = 50;
const DEFAULT_ROW_HEIGHT = 68;

/* 2026-08-28 QA: DEFAULT_ROW_HEIGHT fits the THREE-line anatomy (.rowMain
 * + .rowMeta + padding). A row that also renders `lastError` is a fourth
 * line — 84.2px of content — and VirtualList allocates exactly `rowHeight`
 * with `overflow: hidden` (AUD-A4v6-002), so the surplus came off the last
 * flex child: the error paragraph painted at 0.203px. The failure reason
 * was in the DOM, in its title attribute, and invisible on screen at every
 * viewport.
 *
 * VirtualList's windowing multiplies ONE height, so this cannot vary per
 * row — the panel instead picks the height that fits the tallest anatomy
 * present in the current page. Lists with no failures (the overwhelmingly
 * common case) keep the dense 68px exactly as before. 88 = 24px padding +
 * 21.4 + 17.4 + 17.4 + two 2px gaps + the row's 1px border, rounded up to
 * the next multiple of 4. */
const ERROR_ROW_HEIGHT = 88;

interface JobProgress {
  current: number;
  total: number | null;
  phase: string | null;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function JobRow({ job, progress, compact }: { job: Job; progress: JobProgress | undefined; compact: boolean }): React.JSX.Element {
  const info = describeJobStatus(job.status);
  const isLive = job.status === "queued" || job.status === "active";

  // LD-16 (rc.6): the dashboard embed's card is exactly three facts — job
  // type (the contract has no job NAME field; `type` is the name), the
  // status pill, and one relative time off updatedAtMs. The absolute
  // timestamps are GONE rather than truncated harder: at 1280px the right
  // column leaves ~259px of meta width and two toLocaleString runs have no
  // break opportunity, so they ellipsized mid-token. The live dot,
  // progress, attempts chip and lastError are dropped from THIS surface
  // only. `Date.now()` at render is the existing convention for these
  // strings (LibrariesSection's "Last scan"); the row re-renders on every
  // job.updated event, which is when the age is worth restating anyway.
  // This returns early on purpose: the default markup below is the full
  // /admin/jobs page's row and must stay byte-identical.
  if (compact) {
    return (
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.jobType}>{job.type}</span>
          <StatusPill label={info.label} tone={info.tone} />
        </div>
        <div className={styles.rowMeta}>
          <span className={styles.compactMetaItem}>{formatRelativeTime(job.updatedAtMs, Date.now())}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.jobType}>{job.type}</span>
        <StatusPill label={info.label} tone={info.tone} />
        {isLive && <span className={styles.liveDot} aria-label="Live" title="Live — updating without a page refresh" />}
        {progress && (
          <span className={styles.progress}>
            {progress.phase ? `${progress.phase}: ` : ""}
            {progress.current}
            {progress.total !== null ? ` / ${progress.total}` : ""}
          </span>
        )}
      </div>
      {/* AUD-A4v6-002: meta items ellipsize at narrow panel widths (the
          single-line rule that keeps content inside the fixed 68px
          virtualized row) — title attrs keep the full values reachable,
          same convention as .error below. */}
      <div className={styles.rowMeta}>
        <span className={styles.metaItem} title={`created ${formatTime(job.createdAtMs)}`}>created {formatTime(job.createdAtMs)}</span>
        <span className={styles.metaItem} title={`updated ${formatTime(job.updatedAtMs)}`}>updated {formatTime(job.updatedAtMs)}</span>
        {job.attempts > 0 && <span className={styles.metaItem} title={`${job.attempts} attempt${job.attempts === 1 ? "" : "s"}`}>{job.attempts} attempt{job.attempts === 1 ? "" : "s"}</span>}
      </div>
      {job.lastError && (
        <p className={styles.error} title={job.lastError}>
          {job.lastError}
        </p>
      )}
    </div>
  );
}

export interface JobsPanelProps {
  /** Caps the VirtualList's own scroll region (px). The standalone page
   *  wants the default (VirtualList's own tall default); the dashboard's
   *  embedded panel wants something more modest so it doesn't dominate the
   *  right column. */
  maxHeight?: number;
  /** Header/subtitle — omit for a compact embed (the dashboard supplies its
   *  own <summary> heading instead). @default true */
  showHeader?: boolean;
  /** Row anatomy. `false` (the default, and what the standalone
   *  /admin/jobs page takes) keeps every fact: type, status, live dot,
   *  progress, both absolute timestamps, the attempts chip and lastError.
   *  `true` is LD-16 (rc.6)'s dashboard card — type + status + one
   *  relative time, nothing else — opt-in precisely so the full page's
   *  rows are untouched. @default false */
  compact?: boolean;
}

export function JobsPanel({ maxHeight, showHeader = true, compact = false }: JobsPanelProps): React.JSX.Element {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [progressByJobId, setProgressByJobId] = useState<Record<string, JobProgress>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet("/admin/jobs", { params: { query: { limit: PAGE_LIMIT } } })
      .then((page) => {
        if (cancelled) return;
        setJobs(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(apiErrorCopy(err, "Failed to load jobs."));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    apiGet("/admin/jobs", { params: { query: { limit: PAGE_LIMIT, cursor } } })
      .then((page) => {
        setJobs((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [cursor, loadingMore]);

  // See ERROR_ROW_HEIGHT. `compact` never renders lastError at all (LD-16),
  // so that embed always keeps the dense height.
  const rowHeight = !compact && jobs.some((job) => job.lastError) ? ERROR_ROW_HEIGHT : DEFAULT_ROW_HEIGHT;

  // Live updates — no poll loop while this socket subscription lives.
  useEffect(() => {
    const socket = getEventsSocket();
    const unsubscribe = socket.subscribe<JobUpdatedPayload>("job.updated", (event: EventEnvelope<JobUpdatedPayload>) => {
      const payload = event.payload;
      setJobs((prev) => mergeJobUpdate(prev, payload));
      setProgressByJobId((prev) => {
        const next = { ...prev };
        if (payload.status === "completed" || payload.status === "failed") {
          delete next[payload.jobId];
        } else if (payload.progress) {
          next[payload.jobId] = payload.progress;
        }
        return next;
      });
    });
    return unsubscribe;
  }, []);

  return (
    <>
      {showHeader && (
        <div className={styles.header}>
          <h2 className={styles.title}>Jobs</h2>
          <span className={styles.subtitle}>Live — scans, probes, images, transcodes, and system jobs</span>
        </div>
      )}

      {error && <p className={styles.errorBanner}>{error}</p>}

      {loading ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton radius="sm" width={90} height={16} />
              <Skeleton radius="pill" width={70} height={20} />
              <Skeleton radius="sm" width="40%" height={12} />
            </div>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState icon={Briefcase} title="No jobs yet" body="Scans, probes, image processing, and other background work will show up here." />
      ) : (
        <VirtualList
          items={jobs}
          rowHeight={rowHeight}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          getKey={(job) => job.id}
          renderRow={(job) => <JobRow job={job} progress={progressByJobId[job.id]} compact={compact} />}
          ariaLabel="Jobs"
          {...(maxHeight !== undefined ? { maxHeight } : {})}
        />
      )}
    </>
  );
}
