// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/sections/use-library-scan-status.ts
//
// Derived (never stored) per-library scan status for the Libraries pane's
// "state, last scan" columns (README tab 2 spec). Ground-truthed: Library
// itself carries no `state`/`lastScanAtMs` field (packages/contract/
// openapi.yaml's Library schema — id/name/mediaKind/paths/contentClass/
// itemCount/createdAtMs/updatedAtMs only), and Job rows carry no libraryId
// either (Job.subjectItemId is an ITEM id, not a library id) — there is no
// endpoint that reports "when did this library last finish scanning".
//
// What IS real: scan.started/scan.completed WS events DO carry `libraryId`
// and `completedAtMs` (packages/contract/event-schemas/scan.{started,
// completed}.schema.json) — the same events Sidebar.tsx's useScanBadge
// already subscribes to for the sidebar's amber "Scan" pill. This hook
// mirrors that pattern per-library: `scanning` is live for the session
// (true from scan.started to scan.completed); `lastCompletedAtMs` is only
// ever set from an scan.completed OBSERVED THIS SESSION — there is no
// historical scan log to read on mount, so a library this client hasn't
// seen scan yet reports `lastCompletedAtMs: null` rather than a fabricated
// date (U9). This is real, live, derived data — not a stored duplicate of
// anything the server already owns.

import { useEffect, useState } from "react";
import { getEventsSocket, type EventEnvelope } from "../../../lib/events-socket.js";

export interface LibraryScanStatus {
  scanning: boolean;
  lastCompletedAtMs: number | null;
}

interface ScanStartedPayload {
  jobId: string;
  libraryId: string;
  full: boolean;
  startedAtMs: number;
}

interface ScanCompletedPayload {
  jobId: string;
  libraryId: string;
  completedAtMs: number;
}

export function useLibraryScanStatus(): Map<string, LibraryScanStatus> {
  const [statuses, setStatuses] = useState<Map<string, LibraryScanStatus>>(new Map());

  useEffect(() => {
    const socket = getEventsSocket();

    const unsubStarted = socket.subscribe<ScanStartedPayload>("scan.started", (e: EventEnvelope<ScanStartedPayload>) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        const existing = next.get(e.payload.libraryId);
        next.set(e.payload.libraryId, { scanning: true, lastCompletedAtMs: existing?.lastCompletedAtMs ?? null });
        return next;
      });
    });

    const unsubCompleted = socket.subscribe<ScanCompletedPayload>("scan.completed", (e: EventEnvelope<ScanCompletedPayload>) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(e.payload.libraryId, { scanning: false, lastCompletedAtMs: e.payload.completedAtMs });
        return next;
      });
    });

    return () => {
      unsubStarted();
      unsubCompleted();
    };
  }, []);

  return statuses;
}
