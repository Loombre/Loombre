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
import { mergeJobUpdate, type Job, type JobUpdatedPayload } from "../../lib/admin-jobs-live.js";
import { apiGet, LoombreApiError } from "../../lib/api-client.js";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";
import styles from "./JobsPanel.module.css";

const PAGE_LIMIT = 50;
const DEFAULT_ROW_HEIGHT = 68;

interface JobProgress {
  current: number;
  total: number | null;
  phase: string | null;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function JobRow({ job, progress }: { job: Job; progress: JobProgress | undefined }): React.JSX.Element {
  const info = describeJobStatus(job.status);
  const isLive = job.status === "queued" || job.status === "active";
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
      <div className={styles.rowMeta}>
        <span className={styles.metaItem}>created {formatTime(job.createdAtMs)}</span>
        <span className={styles.metaItem}>updated {formatTime(job.updatedAtMs)}</span>
        {job.attempts > 0 && <span className={styles.metaItem}>{job.attempts} attempt{job.attempts === 1 ? "" : "s"}</span>}
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
}

export function JobsPanel({ maxHeight, showHeader = true }: JobsPanelProps): React.JSX.Element {
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
        setError(err instanceof LoombreApiError ? err.message : "Failed to load jobs.");
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
          rowHeight={DEFAULT_ROW_HEIGHT}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          getKey={(job) => job.id}
          renderRow={(job) => <JobRow job={job} progress={progressByJobId[job.id]} />}
          ariaLabel="Jobs"
          {...(maxHeight !== undefined ? { maxHeight } : {})}
        />
      )}
    </>
  );
}
