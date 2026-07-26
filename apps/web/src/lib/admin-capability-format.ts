// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-capability-format.ts
//
// Pure display formatting for the System panel's CapabilityReport card
// (Phase 4 deliverable D task brief: "probe age + ffmpeg hash prefix").

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Human "probe age" (how long ago verifiedAtMs was) relative to `nowMs`.
 *  Coarse buckets (matches the rest of the app's no-fussy-relative-time
 *  posture) rather than a full i18n-relative-time library — a new
 *  dependency isn't warranted for one string. */
export function formatProbeAge(verifiedAtMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - verifiedAtMs);
  if (deltaMs < MS_PER_MINUTE) return "just now";
  if (deltaMs < MS_PER_HOUR) {
    const minutes = Math.floor(deltaMs / MS_PER_MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (deltaMs < MS_PER_DAY) {
    const hours = Math.floor(deltaMs / MS_PER_HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(deltaMs / MS_PER_DAY);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const HASH_PREFIX_LENGTH = 12;

/** Short, copy-pasteable prefix of a (typically sha256-length)
 *  ffmpegBuildHash — the full hash is available via a title attribute at
 *  the call site, this is just what's shown inline. `null`/empty -> "—". */
export function formatFfmpegHashPrefix(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length <= HASH_PREFIX_LENGTH ? hash : hash.slice(0, HASH_PREFIX_LENGTH);
}
