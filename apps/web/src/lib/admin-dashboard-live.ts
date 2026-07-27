// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/admin-dashboard-live.ts
//
// Admin dashboard (Phosphor retheme Wave 2, Lane L2) live-data helpers. Two
// independent concerns, both riding the SAME shared events socket every
// authenticated session already holds open (AppProviders'
// EventsSocketLifecycle) — no new connections, no polling.
//
//  1. useLibraryScanState — per-library "is this library scanning right
//     now" + a live files-processed COUNT. Correlates scan.started's
//     {jobId, libraryId} to later job.updated{jobId, jobType:'scan',
//     progress} and scan.completed{jobId, libraryId} events — the same
//     jobId-correlation trick shell/Sidebar.tsx's useScanBadge already uses
//     for the sidebar SCAN pill, just keyed per-library instead of
//     "any scan active". NEVER a percentage: apps/worker/src/scan/
//     scanner.ts's maybeCheckpoint only ever reports a raw file count —
//     the streaming walker has no upfront total to divide by (U9, see that
//     function's own header). The dashboard renders an indeterminate,
//     compositor-animated bar alongside this count instead of a fabricated
//     percent.
//
//  2. useEventLog — a bounded ring buffer of every event this admin's
//     socket receives (subscribeAll), newest first, for the dashboard's
//     collapsible event log panel. Client-side only, no new endpoint or
//     persisted log surface — "existing... events surfaces reflowed, not
//     rebuilt".

import { useEffect, useRef, useState } from "react";
import { getEventsSocket, type EventEnvelope } from "./events-socket.js";

/** STATE.md H3 — the most recent scan.completed's skip-visibility report for
 *  a library, once observed this session. `count` is authoritative;
 *  `files.length < count` implies the payload's own list was truncated
 *  (scanner.ts caps it at 100 — see ScanCompletedPayload below). */
export interface LibrarySkippedUnsupported {
  count: number;
  files: string[];
}

/** Owner ledger L1 (adjudication A-4): one admitted file that turned out
 *  unreadable once a real probe ran against it — a probe.failed event's
 *  {path, code}, mediaFileId/libraryId dropped (not needed for display).
 *  DIFFERENT from LibrarySkippedUnsupported: that's an extension the
 *  scanner never admitted at all; this is a file the scanner DID admit,
 *  whose probe job then exhausted its retries — see this file's own
 *  freeze-report note on why scan.completed's schema stays untouched. */
export interface LibraryProbeFailure {
  path: string;
  code: string;
}

export interface LibraryScanState {
  scanning: boolean;
  /** Files processed so far in the active scan; null before the first
   *  checkpoint tick reports, or when not scanning. Never a percentage. */
  filesProcessed: number | null;
  /** Populated from the most recently observed scan.completed event for
   *  this library — persists after scanning finishes (unlike
   *  scanning/filesProcessed) so the admin can actually review it. Reset to
   *  null when a new scan starts, and left null whenever the last completed
   *  scan reported zero skips. */
  lastSkipped: LibrarySkippedUnsupported | null;
  /** Owner ledger L1 (adjudication A-4): every probe.failed event observed
   *  for this library THIS SESSION, newest first, capped at
   *  PROBE_FAILED_MAX entries — unlike lastSkipped, this is deliberately
   *  NOT reset when a new scan starts: probe jobs for files a scan
   *  admitted routinely finish well after that scan's own scan.completed
   *  fires (sometimes across a LATER scan entirely), so tying it to a scan
   *  boundary would drop failures an admin hasn't seen yet. */
  probeFailed: LibraryProbeFailure[];
}

const IDLE_STATE: LibraryScanState = { scanning: false, filesProcessed: null, lastSkipped: null, probeFailed: [] };

/** Owner ledger L1: mirrors EVENT_LOG_MAX's ring-buffer cap pattern below,
 *  scoped per library instead of globally. */
const PROBE_FAILED_MAX = 100;

interface ScanStartedPayload {
  jobId: string;
  libraryId: string;
}
interface ScanCompletedPayload {
  jobId: string;
  libraryId: string;
  /** STATE.md H3 (packages/contract/event-schemas/scan.completed.schema.json
   *  — optional/additive per the evolution policy): known-media-but-
   *  excluded-in-v1 files (ape/wv/wma) this scan walked past. Absent on
   *  events from a pre-H3 worker; treated the same as zero. */
  skippedUnsupportedCount?: number;
  /** Library-root-relative paths, capped server-side at 100 entries. */
  skippedUnsupportedFiles?: string[];
}
interface JobUpdatedProgressPayload {
  jobId: string;
  jobType: string;
  progress?: { current: number; total: number | null; phase: string | null } | null;
}
/** packages/contract/event-schemas/probe.failed.schema.json (owner ledger
 *  L1, adjudication A-2) — ADMIN-ONLY, so this hook only ever observes it
 *  when isAdmin is true (mirrors scan.completed's own admin-gated
 *  subscription below; server-side ws-broadcaster.service.ts enforces the
 *  admin-only delivery independently). */
interface ProbeFailedPayload {
  mediaFileId: string;
  libraryId: string;
  path: string;
  code: string;
}

/** Per-library scan state, live. Returns a Map keyed by libraryId — read a
 *  single library's state with `map.get(libraryId) ?? IDLE_STATE` (exported
 *  as `getLibraryScanState` below for callers that don't want to repeat the
 *  fallback). Admin-only: a non-admin never subscribes (mirrors
 *  useScanBadge/useStoragePool's own `isAdmin` gate). */
export function useLibraryScanState(isAdmin: boolean): Map<string, LibraryScanState> {
  const [state, setState] = useState<Map<string, LibraryScanState>>(new Map());
  const jobToLibraryRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!isAdmin) return undefined;
    const socket = getEventsSocket();

    const unsubStarted = socket.subscribe<ScanStartedPayload>("scan.started", (e: EventEnvelope<ScanStartedPayload>) => {
      jobToLibraryRef.current.set(e.payload.jobId, e.payload.libraryId);
      setState((prev) => {
        const next = new Map(prev);
        const existing = next.get(e.payload.libraryId) ?? IDLE_STATE;
        // A new scan starting clears any prior lastSkipped report — this
        // scan's own scan.completed will repopulate it if it finds any.
        // probeFailed is deliberately CARRIED FORWARD, not reset — see
        // LibraryScanState.probeFailed's doc comment (session-scoped, not
        // scan-scoped).
        next.set(e.payload.libraryId, { scanning: true, filesProcessed: null, lastSkipped: null, probeFailed: existing.probeFailed });
        return next;
      });
    });

    const unsubProgress = socket.subscribe<JobUpdatedProgressPayload>(
      "job.updated",
      (e: EventEnvelope<JobUpdatedProgressPayload>) => {
        if (e.payload.jobType !== "scan" || !e.payload.progress) return;
        const libraryId = jobToLibraryRef.current.get(e.payload.jobId);
        if (!libraryId) return;
        const current = e.payload.progress.current;
        setState((prev) => {
          const next = new Map(prev);
          const existing = next.get(libraryId) ?? IDLE_STATE;
          next.set(libraryId, { ...existing, scanning: true, filesProcessed: current });
          return next;
        });
      },
    );

    const unsubCompleted = socket.subscribe<ScanCompletedPayload>(
      "scan.completed",
      (e: EventEnvelope<ScanCompletedPayload>) => {
        jobToLibraryRef.current.delete(e.payload.jobId);
        const skippedCount = e.payload.skippedUnsupportedCount ?? 0;
        const skippedFiles = e.payload.skippedUnsupportedFiles ?? [];
        setState((prev) => {
          // No prior scan.started required (Lane R review): a completion
          // arriving in a session that never saw the scan start — an admin
          // who opened the dashboard mid-scan — still registers, so the
          // skip note renders for them too. The panel joins on its own
          // libraries list, so an unknown libraryId simply never renders.
          const next = new Map(prev);
          const existing = next.get(e.payload.libraryId) ?? IDLE_STATE;
          next.set(e.payload.libraryId, {
            scanning: false,
            filesProcessed: null,
            lastSkipped: skippedCount > 0 ? { count: skippedCount, files: skippedFiles } : null,
            probeFailed: existing.probeFailed,
          });
          return next;
        });
      },
    );

    // Owner ledger L1 (adjudication A-4): accumulates every probe.failed
    // event this session, per-library, capped at PROBE_FAILED_MAX. See
    // ProbeFailedPayload's doc comment for why this is only ever observed
    // when isAdmin (server-side admin-only delivery is the real gate; this
    // is the client mirroring the same posture scan.completed's own
    // subscription already has).
    const unsubProbeFailed = socket.subscribe<ProbeFailedPayload>(
      "probe.failed",
      (e: EventEnvelope<ProbeFailedPayload>) => {
        setState((prev) => {
          const next = new Map(prev);
          const existing = next.get(e.payload.libraryId) ?? IDLE_STATE;
          const entry: LibraryProbeFailure = { path: e.payload.path, code: e.payload.code };
          next.set(e.payload.libraryId, {
            ...existing,
            probeFailed: [entry, ...existing.probeFailed].slice(0, PROBE_FAILED_MAX),
          });
          return next;
        });
      },
    );

    return () => {
      unsubStarted();
      unsubProgress();
      unsubCompleted();
      unsubProbeFailed();
    };
  }, [isAdmin]);

  return state;
}

export function getLibraryScanState(map: Map<string, LibraryScanState>, libraryId: string): LibraryScanState {
  return map.get(libraryId) ?? IDLE_STATE;
}

// ============================================================================
// Event log (right column, collapsible)
// ============================================================================

export interface EventLogEntry {
  id: string;
  type: string;
  tsMs: number;
}

const EVENT_LOG_MAX = 50;

/** Prepends a new envelope to a bounded, newest-first log — pure so it's
 *  independently testable without a socket. */
export function pushEventLogEntry(prev: EventLogEntry[], envelope: EventEnvelope): EventLogEntry[] {
  return [{ id: envelope.id, type: envelope.type, tsMs: envelope.tsMs }, ...prev].slice(0, EVENT_LOG_MAX);
}

export function useEventLog(isAdmin: boolean): EventLogEntry[] {
  const [entries, setEntries] = useState<EventLogEntry[]>([]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    const socket = getEventsSocket();
    const unsubscribe = socket.subscribeAll((e: EventEnvelope) => {
      setEntries((prev) => pushEventLogEntry(prev, e));
    });
    return unsubscribe;
  }, [isAdmin]);

  return entries;
}
