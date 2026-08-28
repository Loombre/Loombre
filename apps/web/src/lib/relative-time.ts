// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/relative-time.ts
//
// The COMPACT relative-time vocabulary — "just now" / "N min ago" /
// "Nh ago" / "Nd ago". Lifted verbatim (LD-16 (rc.6)) out of
// components/settings/sections/LibrariesSection.tsx, where it was a
// file-local, non-exported function with a single call site; the admin
// dashboard's compact job-queue cards need the same strings, and a second
// copy of a formatter is how two surfaces drift apart. LibrariesSection now
// imports it and renders exactly what it rendered before.
//
// NOT merged with lib/admin-capability-format.ts's formatProbeAge: that one
// is the VERBOSE vocabulary ("5 minutes ago" / "3 hours ago") pinned by its
// own tests and used by CapabilitiesCard + plugin-delivery-status. Two
// deliberate registers, one shared home. As there, no i18n relative-time
// dependency is warranted for a handful of strings.

/** How long ago `ms` was, relative to `nowMs`, in the compact register.
 *  A future timestamp clamps to "just now" rather than reading as a
 *  negative duration. Pure — the clock is an argument, so callers pass a
 *  render-time `Date.now()`. */
export function formatRelativeTime(ms: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (deltaS < 60) return "just now";
  const deltaMin = Math.round(deltaS / 60);
  if (deltaMin < 60) return `${deltaMin} min ago`;
  const deltaH = Math.round(deltaMin / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const deltaD = Math.round(deltaH / 24);
  return `${deltaD}d ago`;
}
