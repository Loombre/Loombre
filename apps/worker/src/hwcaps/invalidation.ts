// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure invalidation decision (docs/PLAYBACK.md §8.1: "invalidated when the
 * bundled ffmpeg or GPU/driver fingerprint changes", STATE.md P3.5). No
 * I/O — the caller (apps/worker/src/index.ts's boot check) supplies both
 * sides already resolved: the CURRENT persisted snapshot's fingerprint
 * (or null, meaning "never probed on this platform") and the FRESHLY
 * computed one (fingerprint.ts + `os.platform()`).
 */

export interface CurrentSnapshotFingerprint {
  ffmpegBuildHash: string;
  gpuFingerprint: string;
}

export interface ResolvedFingerprint {
  ffmpegBuildHash: string;
  gpuFingerprint: string;
}

export type InvalidationReason = 'no-snapshot' | 'ffmpeg-build-hash-changed' | 'gpu-fingerprint-changed' | null;

/**
 * Returns the reason a fresh 'hwprobe' run is needed, or `null` when the
 * current snapshot already matches the freshly-resolved fingerprint (no
 * probe needed). `current === null` means no snapshot has ever been
 * recorded for this platform (fresh install, or first boot after this
 * feature landed) — always invalidates.
 */
export function decideInvalidation(
  current: CurrentSnapshotFingerprint | null,
  resolved: ResolvedFingerprint
): InvalidationReason {
  if (!current) return 'no-snapshot';
  if (current.ffmpegBuildHash !== resolved.ffmpegBuildHash) return 'ffmpeg-build-hash-changed';
  if (current.gpuFingerprint !== resolved.gpuFingerprint) return 'gpu-fingerprint-changed';
  return null;
}
