// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/hwcaps.ts
//
// Writer for the hardware capability self-test snapshot (migrations/
// 0011_hw_capability_snapshots.sql, docs/PLAYBACK.md §8.1, Phase 3 §11
// step 5). The only caller is apps/worker/src/hwcaps/** — either the
// 'hwprobe' job consumer or the `pnpm --filter @loombre/worker run hwprobe`
// operator script — never a viewer-scoped request path (P1.13: this is the
// guard-free internal writer surface).

import type { Selectable } from 'kysely';
import type { HwCapabilityBackendsTable, HwCapabilitySnapshotsTable, HwPlatform } from '../types.js';
import type { DbOrTx } from './tx.js';
import { withTransaction } from './tx.js';

export type HwCapabilitySnapshotRow = Selectable<HwCapabilitySnapshotsTable>;
export type HwCapabilityBackendRow = Selectable<HwCapabilityBackendsTable>;

export interface RecordHwCapabilityBackendInput {
  /** Array position (platform-candidate order, docs/PLAYBACK.md §8.2/§8.3)
   *  — the engine consumes this order verbatim, so it must round-trip. */
  position: number;
  backend: HwCapabilityBackendsTable['backend'];
  decode: HwCapabilityBackendsTable['decode'];
  encode: HwCapabilityBackendsTable['encode'];
  toneMap: HwCapabilityBackendsTable['tone_map'];
  verifiedAtMs: number;
}

export interface RecordVerifiedCapabilitiesInput {
  platform: HwPlatform;
  ffmpegBuildHash: string;
  /** '' when the best-effort per-platform GPU fingerprint command failed
   *  (docs/PLAYBACK.md §8.1 / STATE.md P3.5) — invalidation then keys on
   *  ffmpegBuildHash alone. */
  gpuFingerprint: string;
  verifiedAtMs: number;
  /** MUST already be in the exact order the probe battery produced (== the
   *  platform's candidate order, software last) — this writer preserves
   *  array index as `position`, it does not re-sort. */
  backends: RecordHwCapabilityBackendInput[];
}

export interface RecordedVerifiedCapabilities {
  snapshot: HwCapabilitySnapshotRow;
  backends: HwCapabilityBackendRow[];
}

/**
 * Persists one fresh hardware-capability snapshot for `input.platform`,
 * atomically flipping any prior `is_current` row for that SAME platform to
 * false first (constraint 3: "exactly one is_current per platform row-set
 * in the same tx"). Other platforms' current rows are untouched — a
 * multi-OS dev box (or a future cross-compiled worker) can hold a current
 * snapshot per platform simultaneously; only one platform is ever the
 * worker's OWN `os.platform()` at runtime, but the table doesn't assume
 * that.
 */
export async function recordVerifiedCapabilitiesSnapshot(
  db: DbOrTx,
  input: RecordVerifiedCapabilitiesInput
): Promise<RecordedVerifiedCapabilities> {
  return withTransaction(db, async (trx) => {
    await trx
      .updateTable('hw_capability_snapshots')
      .set({ is_current: false })
      .where('platform', '=', input.platform)
      .where('is_current', '=', true)
      .execute();

    const snapshot = await trx
      .insertInto('hw_capability_snapshots')
      .values({
        ffmpeg_build_hash: input.ffmpegBuildHash,
        gpu_fingerprint: input.gpuFingerprint,
        platform: input.platform,
        verified_at_ms: input.verifiedAtMs,
        is_current: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (input.backends.length === 0) {
      return { snapshot, backends: [] };
    }

    const backends = await trx
      .insertInto('hw_capability_backends')
      .values(
        input.backends.map((b) => ({
          snapshot_id: snapshot.id,
          position: b.position,
          backend: b.backend,
          decode: b.decode,
          encode: b.encode,
          tone_map: b.toneMap,
          verified_at_ms: b.verifiedAtMs,
        }))
      )
      .returningAll()
      .execute();

    return { snapshot, backends };
  });
}
