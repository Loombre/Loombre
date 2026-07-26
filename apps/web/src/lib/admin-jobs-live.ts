// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-jobs-live.ts
//
// Pure merge logic for the admin Jobs dashboard's live-update loop (Phase 4
// deliverable D): GET /admin/jobs seeds the cursor-paged list; every
// `job.updated` event received over the websocket (apps/web/src/lib/
// events-socket.ts, admin-only delivery per apps/server/src/gateway/
// ws-broadcaster.service.ts's ADMIN_ONLY_TYPES) is folded in-place via
// `mergeJobUpdate` — no poll loop while the socket lives (task brief). Kept
// framework-free and pure (no React) so it's unit-testable in isolation,
// matching this codebase's established pattern (grid-windowing.ts,
// playback-reasons.ts, play-queue.ts, ...).
//
// JobUpdatedPayload is hand-mirrored from packages/contract/event-schemas/
// job.updated.schema.json — event-schema payloads aren't part of the
// openapi.yaml-derived @loombre/sdk types (that codegen only covers the REST
// contract), so there is no generated type to import here; this is the same
// "mirror closely enough to catch shape drift" posture apps/server/test/
// conformance.spec.ts's own hand-rolled schemas already use for the same
// reason.

import type { components } from "@loombre/sdk";

export type Job = components["schemas"]["Job"];

export type JobUpdatedStatus = "queued" | "active" | "completed" | "failed";

export interface JobUpdatedPayload {
  jobId: string;
  jobType: string;
  status: JobUpdatedStatus;
  progress?: { current: number; total: number | null; phase: string | null } | null;
  errorMessage?: string | null;
  updatedAtMs: number;
}

/**
 * Folds one `job.updated` event into a jobs array (newest-`createdAtMs`
 * first, matching GET /admin/jobs's own order):
 *   - an existing row (matched by id) is updated in place, preserving its
 *     position — a live status flip must not visually jump the row around;
 *   - an unseen jobId is a job that was created (and, since delivery is
 *     immediate, is likely still 'queued'/'active') after the initial page
 *     load — prepended at the front since GET /admin/jobs orders newest
 *     first and this is, functionally, the newest thing that just happened.
 * `startedAtMs`/`finishedAtMs` are synthesized from the transition itself
 * (the payload carries neither) — best-effort display data only, never
 * treated as authoritative (a later GET /admin/jobs page load or
 * GET /admin/jobs/{id} always wins on next fetch).
 */
export function mergeJobUpdate(jobs: readonly Job[], update: JobUpdatedPayload): Job[] {
  const idx = jobs.findIndex((j) => j.id === update.jobId);

  if (idx === -1) {
    const synthesized: Job = {
      id: update.jobId,
      type: update.jobType,
      status: update.status,
      priority: 0,
      attempts: 0,
      lastError: update.errorMessage ?? null,
      subjectItemId: null,
      createdAtMs: update.updatedAtMs,
      updatedAtMs: update.updatedAtMs,
      startedAtMs: update.status === "active" ? update.updatedAtMs : null,
      finishedAtMs: update.status === "completed" || update.status === "failed" ? update.updatedAtMs : null,
    };
    return [synthesized, ...jobs];
  }

  const existing = jobs[idx]!;
  const updated: Job = {
    ...existing,
    status: update.status,
    lastError: update.errorMessage ?? existing.lastError,
    updatedAtMs: update.updatedAtMs,
    startedAtMs: existing.startedAtMs ?? (update.status === "active" ? update.updatedAtMs : null),
    finishedAtMs:
      update.status === "completed" || update.status === "failed" ? update.updatedAtMs : existing.finishedAtMs,
  };

  const next = jobs.slice();
  next[idx] = updated;
  return next;
}
