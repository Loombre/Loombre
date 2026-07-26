// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/hwcaps.ts
//
// Reads for the hardware capability self-test snapshot (migrations/
// 0011_hw_capability_snapshots.sql, docs/PLAYBACK.md §2.5/§8, Phase 3 §11
// step 5). Home: the PUBLIC barrel, not @loombre/db/internal — same
// reasoning as src/query/identity.ts's header (P1.14 precedent this step
// was pointed at): a hardware-capability snapshot is an INSTANCE fact (one
// truth per running server, keyed by platform), not viewer-scoped catalog
// data, so wrapping these reads in applyGuard()/ViewerContext would be
// both unnecessary and wrong — there is no per-user notion of "which
// backends does this machine's ffmpeg support". apps/server (step 6) reads
// getCurrentVerifiedCapabilities() directly to feed `plan()`'s `caps`
// input; apps/worker reads getCurrentHwCapabilitySnapshot() (the richer
// shape, including the invalidation keys) at boot to decide whether to
// enqueue a fresh 'hwprobe' job.

import type { Kysely } from 'kysely';
import type { DB, HwPlatform } from '../types.js';

export interface VerifiedCapabilityBackend {
  backend: string;
  /** Probe order within the snapshot (docs/PLAYBACK.md §8.2 — load-bearing
   *  for Stage G, migrations/0011's `hw_capability_backends.position`
   *  column). Additive field (Phase 4 deliverable D, GET /admin/capabilities
   *  — packages/contract/openapi.yaml's CapabilityBackend.position): existing
   *  readers of this type (apps/server/src/playback/resolve-caps.ts, cast
   *  straight into @loombre/playback-engine's own VerifiedCapabilities/
   *  VerifiedBackendCapability, which has no `position` field) simply ignore
   *  it — the engine's own ordering is array order, not this number. */
  position: number;
  decode: string[];
  encode: string[];
  toneMap: string[];
  verifiedAtMs: number;
}

/** Exactly docs/PLAYBACK.md §2.5's `VerifiedCapabilities` shape — this is
 *  what `plan()`'s `PlanInput.caps` field expects (step 6 wiring). */
export interface VerifiedCapabilities {
  backends: VerifiedCapabilityBackend[];
}

/** The richer, instance-fact shape: `VerifiedCapabilities` plus the
 *  invalidation keys and metadata a boot-time check or an operator report
 *  needs but the pure engine never sees. */
export interface HwCapabilitySnapshotSummary extends VerifiedCapabilities {
  platform: HwPlatform;
  ffmpegBuildHash: string;
  gpuFingerprint: string;
  verifiedAtMs: number;
}

async function loadCurrentSnapshot(
  db: Kysely<DB>,
  platform: HwPlatform
): Promise<HwCapabilitySnapshotSummary | null> {
  const snapshot = await db
    .selectFrom('hw_capability_snapshots')
    .selectAll()
    .where('platform', '=', platform)
    .where('is_current', '=', true)
    .executeTakeFirst();
  if (!snapshot) return null;

  const backendRows = await db
    .selectFrom('hw_capability_backends')
    .selectAll()
    .where('snapshot_id', '=', snapshot.id)
    .orderBy('position', 'asc')
    .execute();

  return {
    platform: snapshot.platform,
    ffmpegBuildHash: snapshot.ffmpeg_build_hash,
    gpuFingerprint: snapshot.gpu_fingerprint,
    verifiedAtMs: snapshot.verified_at_ms,
    backends: backendRows.map((b) => ({
      backend: b.backend,
      position: b.position,
      decode: b.decode,
      encode: b.encode,
      toneMap: b.tone_map,
      verifiedAtMs: b.verified_at_ms,
    })),
  };
}

/**
 * The current hardware-capability snapshot for `platform`, including the
 * invalidation keys (ffmpeg build hash, GPU fingerprint) — used by
 * apps/worker's boot check (compare against the freshly-resolved current
 * values; missing/mismatched → enqueue 'hwprobe') and by the operator
 * report tooling. `null` when no snapshot has ever been recorded for this
 * platform (fresh install / never probed).
 */
export async function getCurrentHwCapabilitySnapshot(
  db: Kysely<DB>,
  platform: HwPlatform
): Promise<HwCapabilitySnapshotSummary | null> {
  return loadCurrentSnapshot(db, platform);
}

/**
 * The current `VerifiedCapabilities` for `platform` in EXACTLY the §2.5
 * shape `plan()`'s `PlanInput.caps` expects — `null` when no snapshot has
 * ever been recorded (the caller, not this function, decides what a
 * missing snapshot means for a plan request; step 6 concern).
 */
export async function getCurrentVerifiedCapabilities(
  db: Kysely<DB>,
  platform: HwPlatform
): Promise<VerifiedCapabilities | null> {
  const snapshot = await loadCurrentSnapshot(db, platform);
  if (!snapshot) return null;
  return { backends: snapshot.backends };
}
