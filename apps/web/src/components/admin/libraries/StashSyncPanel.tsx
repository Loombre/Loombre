// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/libraries/StashSyncPanel.tsx
//
// StashModal's "Sync" tab: sync controls (POST /admin/libraries/{id}/
// stash-sync, {mode: full|incremental}) + the sync report viewer
// (GET /admin/libraries/{id}/stash-sync-report — STATE.md S8, FX1 items 3+4).
//
// Live status: subscribes to stash.sync.started/stash.sync.completed
// (admin-only delivery, this library's id only) the same way
// use-library-scan-status.ts subscribes to scan.started/scan.completed —
// a running sync shows a live badge, and completion triggers an honest
// refetch of the report (never a fabricated local update: counts are a
// server-computed point-in-time snapshot, StashSyncReport's own doc
// comment).
//
// unmatchedScenes/staleScenes/unmatchedLoombreFiles are independently
// keyset-paginated (each carries its own cursor) — `listSections` below is
// the single array all three render through (the third, FX3's Loombre-side
// unmatched files, landed exactly as the one-array-entry addition this
// structure was built for). Rows are normalized to {key, primary,
// secondary} at the section boundary because scene refs and file refs are
// different shapes on purpose (S4's two sides of the set-difference).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { History } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Button } from "../../ui/Button.js";
import { Tag } from "../../ui/Chip.js";
import { StatusPill } from "../StatusPill.js";
import { EmptyState } from "../EmptyState.js";
import { Skeleton } from "../../skeleton/Skeleton.js";
import { describeStashSyncReportStatus } from "../../../lib/admin-status.js";
import { enumLabel, STASH_SYNC_MODE_LABEL } from "../../../lib/enum-labels.js";
import { apiGet, apiPost } from "../../../lib/api-client.js";
import { getEventsSocket, type EventEnvelope } from "../../../lib/events-socket.js";
import { apiErrorCopy } from "../../../lib/api-error-message.js";
import styles from "./StashSyncPanel.module.css";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];
type StashSyncReport = components["schemas"]["StashSyncReport"];
type StashSyncSceneRef = components["schemas"]["StashSyncSceneRef"];
type StashSyncLoombreFileRef = components["schemas"]["StashSyncLoombreFileRef"];
type SyncMode = components["schemas"]["PostAdminStashSyncRequest"]["mode"];

interface ListState<T> {
  items: T[];
  nextCursor: string | null;
  loadingMore: boolean;
}

type SceneListState = ListState<StashSyncSceneRef>;
type FileListState = ListState<StashSyncLoombreFileRef>;

const EMPTY_LIST: SceneListState = { items: [], nextCursor: null, loadingMore: false };
const EMPTY_FILE_LIST: FileListState = { items: [], nextCursor: null, loadingMore: false };

interface StashSyncStartedPayload {
  jobId: string;
  libraryId: string;
  mode: SyncMode;
  startedAtMs: number;
}

interface StashSyncCompletedPayload {
  jobId: string;
  libraryId: string;
  mode: SyncMode;
  status: string;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

interface RefRow {
  key: string;
  primary: string;
  secondary: string | null;
}

function RefListSection({
  title,
  emptyLabel,
  rows,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  title: string;
  emptyLabel: string;
  rows: RefRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.listSection}>
      <p className={styles.listTitle}>
        {title} <span className={styles.countMono}>· {rows.length}</span>
      </p>
      {rows.length === 0 ? (
        <p className={styles.hint}>{emptyLabel}</p>
      ) : (
        <ul className={styles.sceneList}>
          {rows.map((row) => (
            <li key={row.key} className={styles.sceneRow}>
              <span className={styles.scenePath}>{row.primary}</span>
              {row.secondary !== null && <span className={styles.sceneTime}>{row.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
      {nextCursor !== null && (
        <Button variant="ghost" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

export function StashSyncPanel({ libraryId, connection }: { libraryId: string; connection: AdminStashConnection }): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<StashSyncReport | null>(null);
  const [unmatched, setUnmatched] = useState<SceneListState>(EMPTY_LIST);
  const [stale, setStale] = useState<SceneListState>(EMPTY_LIST);
  const [unmatchedFiles, setUnmatchedFiles] = useState<FileListState>(EMPTY_FILE_LIST);

  const [triggering, setTriggering] = useState<SyncMode | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [lastTriggered, setLastTriggered] = useState<{ jobId: string; mode: SyncMode; atMs: number } | null>(null);
  const [liveJobId, setLiveJobId] = useState<string | null>(null);

  function reload(): void {
    apiGet("/admin/libraries/{id}/stash-sync-report", { params: { path: { id: libraryId } } })
      .then((res) => {
        setReport(res.report);
        setUnmatched({ items: res.unmatchedScenes.items, nextCursor: res.unmatchedScenes.nextCursor, loadingMore: false });
        setStale({ items: res.staleScenes.items, nextCursor: res.staleScenes.nextCursor, loadingMore: false });
        setUnmatchedFiles({
          items: res.unmatchedLoombreFiles.items,
          nextCursor: res.unmatchedLoombreFiles.nextCursor,
          loadingMore: false,
        });
        setLoadError(null);
        setLoading(false);
      })
      .catch((err) => {
        setLoadError(apiErrorCopy(err, "Failed to load the sync report."));
        setLoading(false);
      });
  }

  useEffect(reload, [libraryId]);

  // Live: a sync started/completed for THIS library refreshes the report
  // without a poll loop — same posture JobsPanel/use-library-scan-status.ts
  // already take toward their own live events.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const socket = getEventsSocket();
    const unsubStarted = socket.subscribe<StashSyncStartedPayload>("stash.sync.started", (e: EventEnvelope<StashSyncStartedPayload>) => {
      if (e.payload.libraryId !== libraryId) return;
      setLiveJobId(e.payload.jobId);
    });
    const unsubCompleted = socket.subscribe<StashSyncCompletedPayload>("stash.sync.completed", (e: EventEnvelope<StashSyncCompletedPayload>) => {
      if (e.payload.libraryId !== libraryId) return;
      setLiveJobId(null);
      reloadRef.current();
    });
    return () => {
      unsubStarted();
      unsubCompleted();
    };
  }, [libraryId]);

  function loadMore(which: "unmatched" | "stale" | "loombreFiles"): void {
    if (which === "loombreFiles") {
      if (unmatchedFiles.nextCursor === null || unmatchedFiles.loadingMore) return;
      const cursor = unmatchedFiles.nextCursor;
      setUnmatchedFiles((prev) => ({ ...prev, loadingMore: true }));
      apiGet("/admin/libraries/{id}/stash-sync-report", {
        params: { path: { id: libraryId }, query: { unmatchedLoombreFilesCursor: cursor } },
      })
        .then((res) => {
          const page = res.unmatchedLoombreFiles;
          setUnmatchedFiles((prev) => ({ items: [...prev.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false }));
        })
        .catch(() => setUnmatchedFiles((prev) => ({ ...prev, loadingMore: false })));
      return;
    }
    const current = which === "unmatched" ? unmatched : stale;
    const setState = which === "unmatched" ? setUnmatched : setStale;
    if (current.nextCursor === null || current.loadingMore) return;
    setState((prev) => ({ ...prev, loadingMore: true }));
    apiGet("/admin/libraries/{id}/stash-sync-report", {
      params: {
        path: { id: libraryId },
        query: which === "unmatched" ? { unmatchedCursor: current.nextCursor } : { staleCursor: current.nextCursor },
      },
    })
      .then((res) => {
        const page = which === "unmatched" ? res.unmatchedScenes : res.staleScenes;
        setState((prev) => ({ items: [...prev.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false }));
      })
      .catch(() => setState((prev) => ({ ...prev, loadingMore: false })));
  }

  async function handleSync(mode: SyncMode): Promise<void> {
    setTriggering(mode);
    setTriggerError(null);
    try {
      const res = await apiPost("/admin/libraries/{id}/stash-sync", { params: { path: { id: libraryId } }, body: { mode } });
      setLastTriggered({ jobId: res.jobId, mode, atMs: Date.now() });
    } catch (err) {
      setTriggerError(apiErrorCopy(err, "Failed to start this sync."));
    } finally {
      setTriggering(null);
    }
  }

  const canSync = connection.configured && connection.enabled;
  const syncing = liveJobId !== null || triggering !== null;

  const listSections: {
    key: string;
    title: string;
    emptyLabel: string;
    rows: RefRow[];
    nextCursor: string | null;
    loadingMore: boolean;
    onLoadMore: () => void;
  }[] = [
    {
      key: "unmatched",
      title: "Unmatched Stash scenes",
      emptyLabel: "No unmatched scenes.",
      rows: unmatched.items.map((s) => ({
        key: s.stashSceneId,
        primary: s.stashPath,
        secondary: s.stashUpdatedAtMs !== null ? formatTime(s.stashUpdatedAtMs) : null,
      })),
      nextCursor: unmatched.nextCursor,
      loadingMore: unmatched.loadingMore,
      onLoadMore: () => loadMore("unmatched"),
    },
    {
      key: "stale",
      title: "Stale (removed from Stash)",
      emptyLabel: "No stale scenes.",
      rows: stale.items.map((s) => ({
        key: s.stashSceneId,
        primary: s.stashPath,
        secondary: s.stashUpdatedAtMs !== null ? formatTime(s.stashUpdatedAtMs) : null,
      })),
      nextCursor: stale.nextCursor,
      loadingMore: stale.loadingMore,
      onLoadMore: () => loadMore("stale"),
    },
    {
      key: "loombreFiles",
      title: "Library files with no Stash scene",
      emptyLabel: "Every library file has a matching Stash scene.",
      rows: unmatchedFiles.items.map((f) => ({ key: f.mediaFileId, primary: f.path, secondary: f.itemTitle })),
      nextCursor: unmatchedFiles.nextCursor,
      loadingMore: unmatchedFiles.loadingMore,
      onLoadMore: () => loadMore("loombreFiles"),
    },
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.syncControls}>
        <div className={styles.syncButtons}>
          <Button variant="secondary" onClick={() => void handleSync("incremental")} disabled={!canSync || syncing}>
            {triggering === "incremental" ? "Starting…" : "Incremental sync"}
          </Button>
          <Button variant="primary" onClick={() => void handleSync("full")} disabled={!canSync || syncing}>
            {triggering === "full" ? "Starting…" : "Full sync"}
          </Button>
          {syncing && (
            <span className={styles.liveBadge}>
              <span className={styles.liveDot} aria-hidden="true" />
              Syncing
            </span>
          )}
        </div>

        {!connection.configured ? (
          <p className={styles.hint}>Configure a Stash connection first (Connection tab) before syncing.</p>
        ) : !connection.enabled ? (
          <p className={styles.hint}>This connection is disabled — enable it in the Connection tab before syncing.</p>
        ) : null}

        {lastTriggered && (
          <p className={styles.hint}>
            Started job <code className={styles.jobId}>{lastTriggered.jobId}</code> ({lastTriggered.mode}) at{" "}
            {formatTime(lastTriggered.atMs)} — <Link href="/admin/jobs">view in Jobs →</Link>
          </p>
        )}
        {triggerError && <p className={styles.errorText}>{triggerError}</p>}
      </div>

      {loadError && <p className={styles.errorText}>{loadError}</p>}

      {loading ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} radius="md" height={44} />
          ))}
        </div>
      ) : report === null ? (
        <EmptyState icon={History} title="Never synced yet" body="Run a full or incremental sync above to see a report here." />
      ) : (
        <>
          <div className={styles.reportCard}>
            <div className={styles.reportHeader}>
              <StatusPill label={describeStashSyncReportStatus(report.status).label} tone={describeStashSyncReportStatus(report.status).tone} />
              <Tag>{enumLabel(STASH_SYNC_MODE_LABEL, report.mode)}</Tag>
            </div>
            <dl className={styles.countsGrid}>
              <div>
                <dt>Matched</dt>
                <dd>{report.matchedCount}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{report.updatedCount}</dd>
              </div>
              <div>
                <dt>Unmatched</dt>
                <dd>{report.unmatchedCount}</dd>
              </div>
              <div>
                <dt>Stale</dt>
                <dd>{report.staleCount}</dd>
              </div>
              <div>
                <dt>Skipped</dt>
                <dd>{report.skippedCount}</dd>
              </div>
            </dl>
            <p className={styles.hint}>
              Started {formatTime(report.startedAtMs)} — {report.status === "running" ? "still running" : `finished ${formatTime(report.finishedAtMs)}`}
            </p>
            {report.usedSnapshotFallback === true && (
              <p className={styles.hint}>
                Read from a temporary snapshot copy — your Stash was holding the database locked, so Loombre copied it
                aside and read the copy. The original was not touched.
              </p>
            )}
          </div>

          <div className={styles.listsWrap}>
            {listSections.map((section) => (
              <RefListSection
                key={section.key}
                title={section.title}
                emptyLabel={section.emptyLabel}
                rows={section.rows}
                nextCursor={section.nextCursor}
                loadingMore={section.loadingMore}
                onLoadMore={section.onLoadMore}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
