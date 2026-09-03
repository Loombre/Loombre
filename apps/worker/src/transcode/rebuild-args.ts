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
import type { DeviceProfile, FfmpegPlanShape, MediaInfo, PlanInput } from "@loombre/playback-engine";
import { rungAtIndex, topRungOf, type StoredPlan } from "./plan-shape.js";

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
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
      // Placeholder like every field around it — `buildFfmpegArgs` reads
      // `policy` not at all, and this path REBUILDS args for an
      // already-decided stored plan (whose rung codec is a fact on the
      // plan, not something re-derived here).
      av1EncodePreferred: false,
    },
    caps: { backends: [] },
    mode: "stream",
  };
}

/**
 * The `FfmpegPlanShape` a restart hands the builder — PURE, so the one
 * decision in this module that is not I/O can be tested on its own.
 *
 * `ladderRungIndex` is the rung this restart targets: the §9.1.4
 * slot-handoff target (`pending_rung_index`, the rung the client's `v{K}`
 * path named) for a switch, and the LIVE run's own rung for an ordinary
 * seek-restart — the runner passes it explicitly on every restart
 * (`coincidentRung ?? currentRun.ladderRungIndex`), which is what keeps a
 * post-switch seek on the rung the session was already serving instead of
 * snapping back to the top via the `undefined` fallback below. `undefined`
 * arrives only for a ladder-empty session, where no rung applies at all.
 *
 * THE LOAD-BEARING LINE is `targetCodec: rung.codec`. `buildFfmpegArgs`
 * resolves its encoder name from `video.targetCodec`, NOT from the rung it
 * is handed (see that module's `VIDEO_ENCODER_NAMES` lookup), because for
 * `plan()`'s own call the two are the same thing by construction — the
 * ladder's top rung IS what `targetCodec` was derived from. A rung SWITCH
 * is the first time they can differ: on a mixed-codec ladder (§7.1's av1
 * swap leaves an hevc 2160p rung above av1 sub-rungs) a switch to the av1
 * mid rung under an unchanged `targetCodec: 'hevc'` would spawn `hevc_qsv`
 * at the av1 rung's bitrate and height — a valid-looking argv encoding the
 * wrong bitstream, which nothing downstream would flag. Golden 42 pins the
 * corrected argv.
 *
 * Non-mutating: the stored plan is re-read from the row on every restart
 * and stays the authority.
 */
export function planShapeForRung(plan: StoredPlan, ladderRungIndex: number | undefined): FfmpegPlanShape {
  const base = {
    container: plan.container,
    audio: plan.audio,
    subtitle: plan.subtitle,
  };
  if (plan.video.action !== "transcode") {
    return { ...base, video: plan.video };
  }

  // An out-of-range index cannot arrive in practice (the controller
  // validates 0 <= K < ladder.length before recording one), but falling
  // back to the top rung keeps a restart POSSIBLE either way: a respawn
  // with no rung would hand the builder an encode with no bitrate and no
  // height, and a session that cannot restart is strictly worse than one
  // that restarts at the quality it was already serving.
  const rung = rungAtIndex(plan.ladder, ladderRungIndex) ?? topRungOf(plan.ladder);
  if (rung === undefined) return { ...base, video: plan.video };

  return { ...base, video: { ...plan.video, targetCodec: rung.codec }, rung };
}

/**
 * Regenerates token-form ffmpeg args for a restart — a seek, a §9.1.4 rung
 * handoff, or both at once (§9.1.7's single-restart rule spawns ONE run for
 * a coincident pair). `fileId`/`deviceId` come from the session row; `plan`
 * is the parsed stored plan (plan-shape.ts); `ladderRungIndex` is the rung
 * a handoff is switching to, omitted for a plain seek. Throws
 * `SeekRebuildError` if the file or device can no longer be resolved (both
 * should be impossible in practice — the session already ran once against
 * this exact file/device — but this runtime never silently fabricates a
 * MediaInfo/DeviceProfile).
 */
export async function rebuildSeekArgs(
  db: DbOrTx,
  input: { fileId: string; deviceId: string; plan: StoredPlan; ladderRungIndex?: number },
): Promise<string[]> {
  const media = await getMediaInfoForFile(db, input.fileId);
  if (!media) {
    throw new SeekRebuildError(`media info for file ${input.fileId} could not be re-assembled (probe data missing?)`);
  }

  const device = await getDeviceById(db, input.deviceId);
  if (!device) {
    throw new SeekRebuildError(`device ${input.deviceId} no longer exists`);
  }
  const deviceProfile = device.profile as unknown as DeviceProfile;

  const planInput: PlanInput = {
    media: media as unknown as MediaInfo,
    device: deviceProfile,
    selection: input.plan.selection,
    ...placeholderPlanInputTail(),
  };

  return buildFfmpegArgs(planInput, planShapeForRung(input.plan, input.ladderRungIndex), { withSeek: true });
}
