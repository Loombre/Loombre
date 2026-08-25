// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The shape this runtime needs out of `playback_sessions.plan` (JSONB —
 * CLAUDE.md invariant 3's "serialized plans" whitelist entry).
 *
 * ---------------------------------------------------------------------------
 * REQUIREMENT PLACED ON LANE B (reported prominently — this is the one
 * place this lane's design constrains what the NEXT lane's session-create
 * code must store): the stored JSON must be the full serialized
 * `@loombre/playback-engine` `PlaybackPlan` (docs/PLAYBACK.md §5) PLUS ONE
 * ADDITIONAL SIDECAR KEY, `selection` — the exact `TrackSelection` (§2.6)
 * resolved for this session. This is NOT part of the engine's own §5
 * output contract (untouched, unedited) — it is a persistence-layer
 * convenience this JSONB column's existing whitelist entry already covers
 * (an extra key on an already-whitelisted blob, not a new column, not a
 * schema change). It exists because this runtime's seek-restart path
 * (rebuild-args.ts) must call `buildFfmpegArgs(input, planShape, {withSeek:
 * true})` again — which needs `input.selection` — WITHOUT re-deriving the
 * §2.6 selection algorithm itself (that logic belongs to whatever resolves
 * tracks before calling `plan()` the first time, Lane B's concern, not
 * this runtime's). Without this sidecar key, a seek-restart has no way to
 * know which video/audio/subtitle stream indices the session was ever
 * playing. `network`/`policy`/`caps` are deliberately NOT required back —
 * `buildFfmpegArgs` never reads them (its own header says so), so
 * rebuild-args.ts fills structurally-valid placeholders for those three
 * PlanInput fields instead of asking Lane B to persist anything for them.
 */
import type {
  LadderRung,
  PlaybackPlanAudio,
  PlaybackPlanSubtitle,
  PlaybackPlanVideo,
  TrackSelection,
} from "@loombre/playback-engine";

export interface StoredPlan {
  decision: string;
  container: "source" | "fmp4-hls" | "ts-hls" | "mp4";
  video: PlaybackPlanVideo;
  audio: PlaybackPlanAudio;
  subtitle: PlaybackPlanSubtitle;
  ladder: LadderRung[];
  ffmpegArgs: string[];
  engineVersion: string;
  /** See this module's header — the one field beyond the engine's own §5
   *  PlaybackPlan shape this runtime requires Lane B to also persist. */
  selection: TrackSelection;
}

export class InvalidStoredPlanError extends Error {
  constructor(message: string) {
    super(`transcode runtime: stored session plan is invalid or incomplete — ${message}`);
    this.name = "InvalidStoredPlanError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Minimal structural validation (not full Ajv — this is a TRUSTED
 * internal row this same system wrote, not untrusted external input) that
 * fails LOUDLY with a clear error rather than letting a malformed plan
 * silently misbehave three layers into a spawn call. Every field this
 * runtime actually reads is checked; fields it never touches (`reasons`,
 * `engineVersion`'s exact format, ...) are not.
 */
export function parseStoredPlan(raw: Record<string, unknown> | null): StoredPlan {
  if (!isRecord(raw)) {
    throw new InvalidStoredPlanError("plan column is null or not an object");
  }
  const { decision, container, video, audio, subtitle, ladder, ffmpegArgs, engineVersion, selection } = raw;
  if (typeof decision !== "string") throw new InvalidStoredPlanError("missing/invalid 'decision'");
  if (typeof container !== "string") throw new InvalidStoredPlanError("missing/invalid 'container'");
  if (!isRecord(video)) throw new InvalidStoredPlanError("missing/invalid 'video'");
  if (!isRecord(audio)) throw new InvalidStoredPlanError("missing/invalid 'audio'");
  if (!isRecord(subtitle)) throw new InvalidStoredPlanError("missing/invalid 'subtitle'");
  if (!Array.isArray(ladder)) throw new InvalidStoredPlanError("missing/invalid 'ladder'");
  if (!Array.isArray(ffmpegArgs) || !ffmpegArgs.every((a) => typeof a === "string")) {
    throw new InvalidStoredPlanError("missing/invalid 'ffmpegArgs' (expected string[])");
  }
  if (typeof engineVersion !== "string") throw new InvalidStoredPlanError("missing/invalid 'engineVersion'");
  if (!isRecord(selection)) {
    throw new InvalidStoredPlanError(
      "missing 'selection' sidecar key — Lane B's session-create path must store {...plan(), selection} (see this module's header)",
    );
  }
  const { videoStreamIndex, audioStreamIndex, subtitleStreamIndex } = selection;
  if (
    (videoStreamIndex !== null && typeof videoStreamIndex !== "number") ||
    (audioStreamIndex !== null && typeof audioStreamIndex !== "number") ||
    (subtitleStreamIndex !== null && typeof subtitleStreamIndex !== "number")
  ) {
    throw new InvalidStoredPlanError("invalid 'selection' shape");
  }

  return {
    decision,
    container: container as StoredPlan["container"],
    video: video as unknown as PlaybackPlanVideo,
    audio: audio as unknown as PlaybackPlanAudio,
    subtitle: subtitle as unknown as PlaybackPlanSubtitle,
    ladder: ladder as LadderRung[],
    ffmpegArgs: ffmpegArgs as string[],
    engineVersion,
    selection: {
      videoStreamIndex: (videoStreamIndex as number | null) ?? null,
      audioStreamIndex: (audioStreamIndex as number | null) ?? null,
      subtitleStreamIndex: (subtitleStreamIndex as number | null) ?? null,
    },
  };
}

/**
 * d4-f1: is this plan a COPY SHAPE — i.e. is there no video ENCODE pacing
 * the run?
 *
 * `video.action` is the whole question. `'copy'` is the direct-stream
 * remux the finding names; `'none'` (an audio-only session — a music
 * track, or a video-less stream) has exactly the same property and the
 * same hazard, since a 2-channel Opus encode also runs orders of magnitude
 * faster than realtime. Only `'transcode'` puts a real encoder in the
 * loop, and an encoder is its own pacing.
 *
 * Deliberately keyed on the plan's own field rather than on
 * `decision`: a session can be `decision: 'transcode'` while video is
 * COPIED and only audio is re-encoded — that is the V8 4K-HDR shape, the
 * most common transcode session this server serves, and it is a copy shape
 * for every purpose this predicate exists for.
 */
export function isCopyShapePlan(plan: Pick<StoredPlan, "video">): boolean {
  return plan.video.action !== "transcode";
}

/** Mirrors `@loombre/playback-engine`'s `plan.ts` own `topRung` selection
 *  (highest `videoBitrateBps`) EXACTLY — kept in sync intentionally (that
 *  file's own comment names this as the "DEFAULT rung" convention); a
 *  seek-restart targets the SAME rung the session was already serving,
 *  never a different quality. A RUNG SWITCH is the one thing that does
 *  change quality, and it names its rung by index — `rungAtIndex` below. */
export function topRungOf(ladder: LadderRung[]): LadderRung | undefined {
  return ladder.reduce<LadderRung | undefined>(
    (max, rung) => (max === undefined || rung.videoBitrateBps > max.videoBitrateBps ? rung : max),
    undefined,
  );
}

/**
 * The rung a §9.1.4 slot handoff is switching TO, addressed by its INDEX in
 * the stored plan's ladder — which is exactly what the client's `v{K}` path
 * named and what `pending_rung_index` carries.
 *
 * POSITIONAL, deliberately, not "the Kth highest bitrate": §9.1.1's master
 * playlist emits one `EXT-X-STREAM-INF` per `plan.ladder[K]` **in array
 * order**, and `policy.ladderRungs` is never re-sorted by the engine
 * (`stages/ladder.ts`: "Table order is `policy.ladderRungs` as given"). An
 * admin table that is not bitrate-descending would therefore make a
 * rank-based lookup hand back a different rung than the one the client
 * asked for — silently, at a different quality.
 *
 * `undefined` for anything that does not name a real rung (out of range,
 * negative, non-integer, empty ladder). The caller decides what that means;
 * `rebuild-args.ts` falls back to the top rung rather than restarting with
 * no rung at all.
 */
export function rungAtIndex(ladder: LadderRung[], index: number | undefined | null): LadderRung | undefined {
  if (index === undefined || index === null || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= ladder.length) return undefined;
  return ladder[index];
}
