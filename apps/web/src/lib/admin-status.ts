// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-status.ts
//
// Pure status -> {label, tone} mapping shared by the admin Jobs dashboard
// (Job.status) and Sessions panel (PlaybackSessionStatus) status pills
// (Phase 4 deliverable D). Kept framework-free so the mapping itself is
// unit-testable without rendering anything — StatusPill.tsx is a thin
// presentational wrapper around this.

export type PillTone = "neutral" | "info" | "success" | "danger" | "warning";

export interface StatusPillInfo {
  label: string;
  tone: PillTone;
}

const JOB_STATUS_INFO: Record<string, StatusPillInfo> = {
  queued: { label: "Queued", tone: "neutral" },
  active: { label: "Active", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Job.status (packages/contract/openapi.yaml's JobStatus enum:
 *  queued|active|completed|failed|cancelled). Falls back to a neutral
 *  pill showing the raw value for anything unrecognized — never throws on
 *  a future additive enum value the client hasn't been updated for yet. */
export function describeJobStatus(status: string): StatusPillInfo {
  return JOB_STATUS_INFO[status] ?? { label: status, tone: "neutral" };
}

const SESSION_STATUS_INFO: Record<string, StatusPillInfo> = {
  created: { label: "Created", tone: "neutral" },
  starting: { label: "Starting", tone: "info" },
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "warning" },
  seeking: { label: "Seeking", tone: "info" },
  ended: { label: "Ended", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

/** PlaybackSessionStatus (packages/contract/openapi.yaml). */
export function describeSessionStatus(status: string): StatusPillInfo {
  return SESSION_STATUS_INFO[status] ?? { label: status, tone: "neutral" };
}
