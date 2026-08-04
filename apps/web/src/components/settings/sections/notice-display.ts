// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/notice-display.ts
//
// Pure, framework-free display helpers shared by the Settings -> Notices
// surface's three cards (ActiveNoticeCard, ComposeNoticeCard,
// NoticeHistoryPanel) — same "pure status -> {label, tone} mapping,
// unit-testable without rendering anything" posture as lib/admin-status.ts's
// describe* functions (StatusPill.tsx's own precedent). Kept LOCAL to this
// lane's own files rather than extending that shared module — this run's
// lane brief draws a hard file-ownership boundary against Lane C working
// in parallel on the same base, and admin-status.ts isn't in this lane's
// owned-files list.

import type { PillTone } from "../../../lib/admin-status.js";
import type { components } from "@loombre/sdk";

type NoticeSeverity = components["schemas"]["NoticeSeverity"];
type NoticeStatus = components["schemas"]["SystemNoticeAdmin"]["status"];

export interface PillInfo {
  label: string;
  tone: PillTone;
}

const SEVERITY_INFO: Record<NoticeSeverity, PillInfo> = {
  info: { label: "Info", tone: "info" },
  warning: { label: "Warning", tone: "warning" },
  critical: { label: "Critical", tone: "danger" },
};

/** Mission's StatusPill tone mapping: info->info / warning->warning /
 *  critical->danger. Falls back to a neutral pill on an unrecognized value
 *  — same forward-compat posture as every other describe* in this app,
 *  never throws on a future additive enum value this client hasn't seen. */
export function describeNoticeSeverity(severity: string): PillInfo {
  return SEVERITY_INFO[severity as NoticeSeverity] ?? { label: severity, tone: "neutral" };
}

const STATUS_INFO: Record<NoticeStatus, PillInfo> = {
  active: { label: "Active", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** SystemNoticeAdmin.status ("derived at read time... never stored" per the
 *  contract) — cancelled reads neutral, not danger: it's a deliberate admin
 *  action, not a failure state. */
export function describeNoticeStatus(status: string): PillInfo {
  return STATUS_INFO[status as NoticeStatus] ?? { label: status, tone: "neutral" };
}

/** Absolute local time + a short relative hint ("in 4 min" / "12 min ago")
 *  — a static snapshot computed at render time, NOT a live-ticking
 *  countdown. The LIVE countdown (N4) is the all-user client rendering
 *  requirement, owned by the parallel client-rendering lane's banner/toast
 *  surfaces; this admin history/status card only needs an honest instant. */
export function formatAbsoluteWithRelative(ms: number, nowMs: number = Date.now()): string {
  const absolute = new Date(ms).toLocaleString();
  const diffMin = Math.round((ms - nowMs) / 60_000);
  if (Math.abs(diffMin) < 1) return `${absolute} (now)`;
  const magnitude = Math.abs(diffMin);
  const unit = magnitude < 60 ? `${magnitude} min` : `${Math.round(magnitude / 60)} h`;
  return diffMin > 0 ? `${absolute} (in ${unit})` : `${absolute} (${unit} ago)`;
}

/** First 8 hex chars of a uuid for a compact monospace display — callers
 *  should still put the full id in a `title` attribute. There is no
 *  username join anywhere in the contract (SystemNoticeAdmin.createdBy is
 *  a bare uuid|null) so this is the honest amount of identity this surface
 *  can show without inventing a lookup that doesn't exist. */
export function shortUuid(id: string): string {
  return id.slice(0, 8);
}

/** Truncates a notice message for a list row, title-attribute carries the
 *  full text (InvitesPanel.tsx's presetSummary/rowTitle precedent). */
export function truncateMessage(message: string, max = 80): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}
