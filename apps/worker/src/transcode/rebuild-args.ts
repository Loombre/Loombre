// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Seek-restart args regeneration (docs/PLAYBACK.md §9, this step's binding
 * constraint 5: "regenerate args via buildFfmpegArgs with withSeek true").
 * `@loombre/playback-engine`'s `buildFfmpegArgs` is PURE and only reads
 * `input.media`/`input.selection`/`input.device.video` (its own module
 * header) — this function's whole job is reassembling exactly those three
 * things from what the row/DB already has, per plan-shape.ts's header:
 *   - `media`   re-read fresh via getMediaInfoForFile (the file hasn't
 *               changed mid-session; re-reading is simpler and no less
 *               correct than caching it, and stays correct if a rescan
 *               ever updates the row between session start and a seek).
 *   - `device`  re-read via getDeviceById(deviceId).profile — devices.
 *               profile is schema-validated once at login (P2.3) and
 *               trusted here exactly like every other consumer of it.
 *   - `selection` the plan's own stored `selection` sidecar (plan-shape.ts).
 * `network`/`policy`/`caps` are structurally-valid PLACEHOLDERS —
 * `buildFfmpegArgs` never reads them (confirmed in its own source), so
 * fabricating real ones would be pure ceremony.
 */
import type { DbOrTx } from "@loombre/db/internal";
import { getMediaInfoForFile } from "@loombre/db/internal";
import { getDeviceById } from "@loombre/db";
import { buildFfmpegArgs } from "@loombre/playback-engine";
import type { DeviceProfile, MediaInfo, PlanInput } from "@loombre/playback-engine";
import { topRungOf, type StoredPlan } from "./plan-shape.js";

export class SeekRebuildError extends Error {}

function placeholderPlanInputTail(): Pick<PlanInput, "network" | "policy" | "caps" | "mode"> {
  return {
    network: { maxBitrateBps: Number.MAX_SAFE_INTEGER, isLocal: true },
    policy: {
      allowTranscode: true,
      allowToneMapCpu: "tier-gated",
      tier: 0,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 1,
      ladderRungs: [],
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
    },
    caps: { backends: [] },
    mode: "stream",
  };
}

/**
 * Regenerates token-form ffmpeg args for a seek-restart. `fileId`/
 * `deviceId` come from the session row; `plan` is the parsed stored plan
 * (plan-shape.ts). Throws `SeekRebuildError` if the file or device can no
 * longer be resolved (both should be impossible in practice — the session
 * already ran once against this exact file/device — but this runtime
 * never silently fabricates a MediaInfo/DeviceProfile).
 */
export async function rebuildSeekArgs(db: DbOrTx, input: { fileId: string; deviceId: string; plan: StoredPlan }): Promise<string[]> {
  const media = await getMediaInfoForFile(db, input.fileId);
  if (!media) {
    throw new SeekRebuildError(`media info for file ${input.fileId} could not be re-assembled (probe data missing?)`);
  }

  const device = await getDeviceById(db, input.deviceId);
  if (!device) {
    throw new SeekRebuildError(`device ${input.deviceId} no longer exists`);
  }
  const deviceProfile = device.profile as unknown as DeviceProfile;

  const rung = input.plan.video.action === "transcode" ? topRungOf(input.plan.ladder) : undefined;

  const planInput: PlanInput = {
    media: media as unknown as MediaInfo,
    device: deviceProfile,
    selection: input.plan.selection,
    ...placeholderPlanInputTail(),
  };

  return buildFfmpegArgs(
    planInput,
    rung !== undefined
      ? { container: input.plan.container, video: input.plan.video, audio: input.plan.audio, subtitle: input.plan.subtitle, rung }
      : { container: input.plan.container, video: input.plan.video, audio: input.plan.audio, subtitle: input.plan.subtitle },
    { withSeek: true },
  );
}
