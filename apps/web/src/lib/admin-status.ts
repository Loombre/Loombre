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

const STASH_CONNECTION_STATUS_INFO: Record<string, StatusPillInfo> = {
  never_connected: { label: "Never connected", tone: "neutral" },
  ok: { label: "Connected", tone: "success" },
  unreachable: { label: "Unreachable", tone: "danger" },
  unsupported_schema: { label: "Unsupported schema", tone: "warning" },
};

/** AdminStashConnectionStatus (STATE.md Stash run S3, FX1). Falls back to a
 *  neutral pill showing the raw value — same forward-compat posture as
 *  describeJobStatus/describeSessionStatus, never throws on a future
 *  additive status value this client hasn't been updated for yet. */
export function describeStashConnectionStatus(status: string): StatusPillInfo {
  return STASH_CONNECTION_STATUS_INFO[status] ?? { label: status, tone: "neutral" };
}

const STASH_SYNC_REPORT_STATUS_INFO: Record<string, StatusPillInfo> = {
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

/** StashSyncReport.status (GET /admin/libraries/{id}/stash-sync-report, S8). */
export function describeStashSyncReportStatus(status: string): StatusPillInfo {
  return STASH_SYNC_REPORT_STATUS_INFO[status] ?? { label: status, tone: "neutral" };
}

const INVITE_STATUS_INFO: Record<string, StatusPillInfo> = {
  pending: { label: "Pending", tone: "info" },
  claimed: { label: "Claimed", tone: "success" },
  revoked: { label: "Revoked", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
};

/** Invite.status (packages/contract/openapi.yaml's InviteStatus enum, E2 —
 *  "derived at read time from claimedAtMs/revokedAtMs/expiresAtMs, never
 *  stored"). Used by InvitesPanel.tsx. */
export function describeInviteStatus(status: string): StatusPillInfo {
  return INVITE_STATUS_INFO[status] ?? { label: status, tone: "neutral" };
}
