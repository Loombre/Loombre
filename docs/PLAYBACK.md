# LOOMBRE — PLAYBACK ENGINE SPECIFICATION
### Authoritative annex to TECHNICAL_DEVELOPMENT_PLAN.md (v1.1) — governs plan §7

> **Status:** v1.0 approved-pending-owner-review. Place as `docs/PLAYBACK.md` in
> the repo beside `docs/PLAN.md`. The Phase 3 orchestration prompt is generated
> from this document. Where this spec and implementation convenience conflict,
> the spec wins; proposed spec changes are PRs against this file, never silent
> code divergence.

---

## 0. Design laws

1. **Purity.** `plan()` performs no I/O, reads no environment, calls no clock.
   Everything it needs arrives as arguments; identical inputs produce a
   byte-identical serialized plan (stable JSON key ordering).
2. **Direct-play bias.** The engine must *prove* a deviation. Every step away
   from serving the original file requires an emitted `PlanReason`. If no
   reason fires, the decision is `direct-play` — this is enforced by a
   property test, not convention.
3. **Reasons are the contract.** A plan without complete reasons is a bug even
   if playback works. Reasons drive diagnostics, admin UI ("why is this
   transcoding?"), matrix assertions, and regression triage.
4. **Verified capabilities only.** The engine never assumes hardware support;
   it consumes the `VerifiedCapabilities` snapshot produced by self-tests
   (§8). Driver marketing is not capability.
5. **Tier-0 respect.** Policies default to protecting small machines: refuse
   CPU-melting paths with a reason rather than degrade the whole server.

## 1. Function signature & module layout

```ts
// packages/playback-engine/src/index.ts
export function plan(input: PlanInput): PlaybackPlan;

export interface PlanInput {
  media: MediaInfo;                  // from media_files + media_streams rows
  device: DeviceProfile;             // client-declared, validated, cached on devices.profile
  network: NetworkConditions;
  policy: ServerPolicy;              // instance + per-user knobs, resolved by caller
  caps: VerifiedCapabilities;        // hardware self-test results snapshot
  selection: TrackSelection;         // resolved BEFORE plan() (see §3.0)
  mode: 'stream' | 'download';       // download reserved: may emit 'remux'
}
```
Internal layout (each stage a pure module with its own matrix cases):
`select/` (track resolution helpers used by caller), `stages/container.ts`,
`stages/video.ts`, `stages/hdr.ts`, `stages/audio.ts`, `stages/subtitle.ts`,
`stages/ladder.ts`, `stages/hardware.ts`, `args/builder.ts`, `reasons.ts`,
`types.ts`. No file imports NestJS, node:fs, node:os, or Date.

## 2. Input type contracts (complete)

### 2.1 MediaInfo

**v1.1 widening (STATE.md H3):** `Container` gained `asf`|`mpeg`|`flv`|`aac`|
`aiff` so the scanner can admit their source extensions (wmv/wma→asf,
mpg/mpeg/vob→mpeg, flv, bare-ADTS aac, aiff) without a permanently-unplayable
catalog item — docs/PLAN.md §8.1's ingestion generosity, the plan engine
already decides transcoding. No device ever declares these direct-playable
(`DeviceProfile.directPlayContainers`); Stage A treats them exactly like any
other non-direct-playable container. `ape`/`wv`/`wma` stay OUT of v1 (rare,
thin codec support) — the scanner reports them as a visible skip rather than
ingesting or throwing.

```ts
interface MediaInfo {
  fileId: string;
  container: Container;              // 'mp4'|'mkv'|'webm'|'avi'|'ts'|'mov'|'flac'|'mp3'|'ogg'|'m4a'|'wav'|'asf'|'mpeg'|'flv'|'aac'|'aiff'
  durationMs: number;
  sizeBytes: number;
  overallBitrateBps: number;         // size/duration derived if probe lacks it
  video: VideoStream[];              // may be empty (music)
  audio: AudioStream[];
  subtitle: SubtitleStream[];
}
interface VideoStream {
  index: number;
  codec: 'h264'|'hevc'|'av1'|'vp9'|'mpeg2'|'vc1'|'mpeg4'|'unknown';
  profile: string | null;            // e.g. 'high','main10'
  level: number | null;              // e.g. 41 for 4.1
  width: number; height: number;
  bitDepth: 8|10|12;
  frameRate: number;                 // rational resolved to float, 3 decimals
  bitrateBps: number | null;
  hdr: 'none'|'hdr10'|'hlg'|'dv';    // from color_transfer + side data
  dvProfile: number | null;          // 5|7|8 when hdr==='dv'
  dvBlCompatId: number | null;       // 8.1 HDR10-compatible base layer detection
  interlaced: boolean;
  openGop: boolean;                  // ffmpeg-verified 2026-08-10; DB NULL -> false (conservative)
}
interface AudioStream {
  index: number;
  codec: 'aac'|'ac3'|'eac3'|'truehd'|'dts'|'dtshd'|'flac'|'opus'|'mp3'|'vorbis'|'pcm'|'unknown';
  channels: number; sampleRate: number;
  bitrateBps: number | null;
  language: string | null;           // ISO 639-2
  isDefault: boolean;
  hasAtmos: boolean;                 // TrueHD/EAC3 JOC side data
}
interface SubtitleStream {
  index: number;
  codec: 'subrip'|'ass'|'webvtt'|'mov_text'|'pgs'|'vobsub'|'dvbsub'|'unknown';
  language: string | null;
  isForced: boolean; isDefault: boolean; isExternal: boolean;
  externalPath: string | null;       // sidecar files, pre-resolved by caller
}
```
**Kind partition:** `codec in {subrip, ass, webvtt, mov_text}` = TEXT;
`{pgs, vobsub, dvbsub}` = IMAGE. `unknown` of either kind → treat as IMAGE
(conservative: burn-in path) with reason `subtitle-codec-unknown`.

### 2.2 DeviceProfile (client-declared at login; server-validated against schema)
```ts
interface DeviceProfile {
  profileId: string;                 // e.g. 'web-chrome', 'web-safari'
  directPlayContainers: Container[];
  hls: { container: 'fmp4'|'ts'; supportsFmp4: boolean; lowLatency: boolean };
  video: Array<{
    codec: VideoStream['codec'];
    maxProfile: string | null; maxLevel: number | null;
    maxBitDepth: 8|10; maxWidth: number; maxHeight: number;
    maxFrameRate: number; maxBitrateBps: number | null;
  }>;
  hdr: { hdr10: boolean; hlg: boolean; dolbyVision: boolean };
  audio: Array<{
    codec: AudioStream['codec']; maxChannels: number;
    passthrough: boolean;            // bitstream passthrough (TrueHD/DTS-HD)
  }>;
  subtitles: { renderText: SubtitleStream['codec'][]; hlsVtt: boolean;
               renderImage: boolean };
  maxStreamBitrateBps: number | null; // device hard cap (TV SoC limits)
}
```
Web clients build this by MSE `isTypeSupported`/`canPlayType` probing at login;
the server rejects profiles failing schema validation (never "best guess" a
malformed profile — reason the request as 422 upstream, not inside `plan()`).

### 2.3 NetworkConditions
```ts
interface NetworkConditions {
  maxBitrateBps: number;   // min(user setting, measured estimate, device cap)
  isLocal: boolean;        // RFC1918/loopback source — relaxes bitrate rung cap only
}
```

### 2.4 ServerPolicy (resolved defaults shown)
```ts
interface ServerPolicy {
  allowTranscode: boolean;                 // true
  allowToneMapCpu: 'always'|'never'|'tier-gated';  // 'tier-gated' (T0 → never)
  tier: 0|1|2;
  preferredTextSubMode: 'hls-vtt'|'burn-in';       // 'hls-vtt'
  preserveAssStyling: boolean;             // false → ASS converts to VTT
  audioTranscodeCodecPriority: ('opus'|'aac')[];   // ['opus','aac'] filtered by device
  maxSimultaneousTranscodes: number;       // tier-derived, overridable
  ladderRungs: LadderRung[];               // instance ladder table (§7)
  segmentDurationSec: 6;                   // fixed v1
  hevcEncodePreferred: boolean;            // true when caps verify hevc encode
  av1EncodePreferred: boolean;             // false; operator PREFERENCE verbatim (LD-7 — see note)
}
```

**`av1EncodePreferred` asymmetry (LD-7, deliberate).** `hevcEncodePreferred`
arrives ALREADY resolved (operator setting AND caps-verified hevc encode,
`apps/server/src/playback/resolve-policy.ts`) because its only gate is a
capability fact. `av1EncodePreferred` is passed through VERBATIM — the raw
`transcode.av1EncodePreferred` setting (default `false`), never AND-ed with
capability by the caller — because AV1's gate is a TIER LAW (§7.2, LD-16)
that must be enforced INSIDE the pure engine, from `caps` + `policy.tier`,
where the matrix can prove its unreachability property. Resolving it
caller-side would put the law's enforcement outside the tested function —
exactly the reason/flag-drift failure class the LD-3 shared-predicate fix
(§3 Stage C) exists to prevent. Tier-0 lens: a preference flag alone never
costs an N100 a CPU cycle — §7.2's eligibility gate decides what it may
actually do.

### 2.5 VerifiedCapabilities — see §8 for how it is produced
```ts
interface VerifiedCapabilities {
  backends: Array<{
    backend: 'videotoolbox'|'qsv'|'vaapi'|'nvenc'|'amf'|'d3d11va'|'software';
    decode: VideoStream['codec'][];
    encode: ('h264'|'hevc'|'av1')[];
    toneMap: ('opencl'|'vulkan'|'videotoolbox'|'cuda'|'none')[];
    verifiedAtMs: number;
  }>;
}
```

### 2.6 TrackSelection (resolved by session service BEFORE plan(); rules here so
they are testable): video = first non-thumbnail video stream unless user pins;
audio = user pin → else language-pref match → else `isDefault` → else index 0;
subtitle = user pin → else forced-flag stream matching the user's subtitle-
language preference when they have one, else the RESOLVED audio stream's
language (auto) → else none. Selection emits no reasons; it is input.

Both language-preference legs above (user_settings.prefs'
`audioPreferredLanguage`/`subtitlePreferredLanguage`, H1) match via
ISO 639-2 bibliographic/terminologic equivalence — a preference stored as
one code (e.g. "fra") matches a stream tagged with its equivalence-pair
partner ("fre") — see `packages/shared/src/language-codes.ts`'s
`languageMatches()`. The subtitle leg's matching key is
`subtitleLanguagePref ?? resolvedAudioLanguage`: an explicit subtitle-
language preference always takes priority over the audio-language auto-
match when both exist; this is still ONLY ever a forced-track auto-match —
a subtitle-language preference does not cause a non-forced subtitle to be
auto-selected.

## 3. The decision algorithm (ordered; later stages may upgrade, never
downgrade, the transcode requirement)

Stage order is normative. Each stage returns `{verdict, reasons[]}` and the
final decision is the max severity across stages:
`direct-play < direct-stream < transcode` (`remux` only in download mode).

**Stage A — Container.** If `media.container ∈ device.directPlayContainers`
AND every SELECTED stream is playable as-is (checked by later stages returning
copy verdicts) → candidate `direct-play`. Otherwise container repackaging is
required → at least `direct-stream`, reason `container-not-direct-playable`.
(A is re-evaluated after B–E: direct-play requires ALL of B–E to be `copy`.)

**Stage B — Video.**
1. Interlaced source → transcode (deinterlace), reason `video-interlaced`.
2. Codec not in device.video → transcode, `video-codec-unsupported`.
3. Codec supported but profile/level/bitDepth/resolution/framerate exceeds the
   device entry → transcode, one reason per exceeded axis:
   `video-profile-unsupported` | `video-level-exceeds-device` |
   `video-bitdepth-unsupported` | `video-resolution-exceeds-device` |
   `video-framerate-exceeds-device`.
4. Else verdict `copy`.

**Stage C — HDR (only when B verdict is copy or transcode-with-copy-possible).**
Evaluated on source `hdr`:
- `dv` profile 5 (no compatible base): device.dolbyVision → copy; else
  tone-map REQUIRED, reason `dv-profile5-requires-tonemap`.
- `dv` profile 7/8: device.dolbyVision → copy; else if dvBlCompatId marks an
  HDR10-compatible BL and device.hdr10 → copy base layer with reason
  `dv-stripped-to-hdr10` (bitstream-level strip in the arg builder, no
  re-encode — see §6 segment 7 for exactly what is emitted);
  else tone-map required, `hdr-tone-map-required`.
  - **The strip is REAL as of ENGINE_VERSION 0.9.0 (LD-3/LD-15,
    2026-08-11).** It previously described itself as a "metadata strip in
    arg builder" while the builder emitted nothing at all, so a DV copy
    carried its RPU — and, for dual-layer profile 7, its whole enhancement
    layer — through to an HDR10-only device. One predicate
    (`src/dv.ts`'s `dvStripApplies()`) now decides BOTH the reason and the
    ffmpeg flags, so the two cannot drift apart again.
  - **Profile 7 dual-layer (LD-15):** the enhancement layer is dropped by
    the same strip — it is meaningless without the RPU that drives it.
    Profile-7 sources are NOT gated out; they strip to single-layer HDR10
    like profile 8.1 does. The outcome difference is reported in the
    reason's `detail` (`elDropped=true|false`), not as a separate reason
    code: `PlanReasonCode` is a closed enum whose additions are contract
    PRs (§4).
- `hdr10`/`hlg`: device supports matching flag → copy; else tone-map required,
  `hdr-tone-map-required`.
Tone-map required → transcode. Method chosen in Stage G; if Stage G yields no
hardware method and `allowToneMapCpu` resolves to never →
**decision = `unplayable-as-requested`**? No: the engine NEVER emits
unplayable; it emits transcode with `ladder: []` and reason
`tone-map-refused-by-policy`, and the session layer surfaces the failure. This
keeps the output contract total.

**Stage D — Audio (per selected stream).**
1. Codec unsupported by device → transcode audio, `audio-codec-unsupported`.
2. Channels > device max for that codec → transcode audio (downmix to device
   max, standard mixdown matrices, no dynamic-range compression by default),
   `audio-channels-exceed-device`.
3. TrueHD/DTS-HD: copy ONLY when device entry has `passthrough:true`; else
   transcode, `audio-passthrough-unsupported`. Atmos flag lost on transcode →
   additional informational reason `audio-atmos-lost`.
4. Target codec = first of `policy.audioTranscodeCodecPriority` present in
   device.audio. Target bitrate: 2ch→160k, 6ch→384k, 8ch→512k (opus scales
   0.75×). Sample rate preserved ≤48k, else resample 48k.
5. Music mode (no video streams): FLAC/ALAC copy when supported; gapless
   requires `direct-play` or fmp4 `direct-stream` — a music transcode carries
   reason `gapless-degraded` so clients can warn.

**Stage E — Subtitles (selected subtitle only; none selected → verdict none).**
```
TEXT codec:
  device.subtitles.hlsVtt && policy.preferredTextSubMode==='hls-vtt'
      → 'hls-vtt' (segmented WebVTT side-track; ASS loses styling →
        add reason 'subtitle-styling-lost' when codec==='ass'
        unless policy.preserveAssStyling → then 'burn-in',
        reason 'subtitle-burn-in-for-styling')
  device renders codec natively in directPlayContainer → 'embed' (copy)
  else → 'burn-in', reason 'subtitle-format-requires-burn-in'
IMAGE codec (pgs|vobsub|dvbsub|unknown):
  device.subtitles.renderImage && container playable → 'embed'
  else → 'burn-in', reason 'subtitle-format-requires-burn-in'
```
`burn-in` FORCES video transcode (adds `video-transcode-for-subtitle-burn-in`
if B verdict was copy). `hls-vtt` and `none` never force video work.

**Stage F — Bitrate & ladder (§7).** If final video verdict is copy AND
`overallBitrateBps > network.maxBitrateBps` → transcode video, reason
`bitrate-exceeds-network` (unless `network.isLocal` and bitrate ≤ device cap).
Ladder is constructed whenever the decision is transcode.

**Stage G — Hardware routing (only when transcoding video).** See §8.3 for
selection. Emits `hw-encoder-selected:<backend>` informational reason or
`software-fallback:<cause>`.

**Final assembly.** Decision:
- all stages copy/none + container direct-playable → `direct-play`
- all streams copy but container repackage needed → `direct-stream`
  (HLS, `-c copy` all mapped streams)
- any stream transcoded → `transcode`
- mode==='download' and container-only change → `remux` (progressive file)
Plan always includes: every fired reason (ordered by stage, then axis),
per-track actions, subtitle strategy, ladder (may be empty for copy/audio-only
decisions), and ffmpegArgs per §6 (empty array for `direct-play`).

**Open-GOP HEVC leading-pictures strip (2026-08-10; predicate corrected by
opus review Finding D, same day).** Decided HERE, at final assembly, not
inside Stage B — the flag and its reason need facts (the FINAL `container`
and `video.action`) that aren't settled until every stage (including D/E/F)
has run. When the final `video.action === 'copy'` AND the final `container`
is `fmp4-hls`|`ts-hls` (a repackaged copy — never `'source'`/`'mp4'`) AND the
selected stream is `hevc` with `openGop === true`: `video.openGop` is set
true (§5), and an additional INFORMATIONAL reason
`open-gop-leading-pictures-stripped` is appended after every Stage A-F
reason already collected (the same position any other assembly-level
addition lands in, since nothing about this predicate can be known earlier).
The strip itself happens in the arg builder (§6) on a seek-restart, never a
re-encode, so this can never change any stage's verdict. An EARLIER version
of this rule lived inside Stage B, gated on Stage A's OWN verdict
(container-not-direct-playable) rather than the plan's FINAL container —
that predicate could diverge from the flag's in both directions (a
container that Stage A itself found direct-playable but that ends up
repackaged anyway for an unrelated reason, e.g. Stage D forcing an audio
transcode, stripped with no reason reported; a later stage, e.g. C or F,
escalating video to a full transcode reported the reason despite no strip
ever happening). Matrix cases 516/517 pin both former divergence
directions.

## 4. Reason taxonomy (closed enum; additions are contract PRs)

Blocking-class: `container-not-direct-playable`, `video-codec-unsupported`,
`video-profile-unsupported`, `video-level-exceeds-device`,
`video-bitdepth-unsupported`, `video-resolution-exceeds-device`,
`video-framerate-exceeds-device`, `video-interlaced`,
`hdr-tone-map-required`, `dv-profile5-requires-tonemap`,
`tone-map-refused-by-policy`, `audio-codec-unsupported`,
`audio-channels-exceed-device`, `audio-passthrough-unsupported`,
`subtitle-format-requires-burn-in`, `subtitle-burn-in-for-styling`,
`video-transcode-for-subtitle-burn-in`, `bitrate-exceeds-network`,
`subtitle-codec-unknown`, `transcode-disabled-by-policy`.
Informational-class: `dv-stripped-to-hdr10`, `subtitle-styling-lost`,
`audio-atmos-lost`, `gapless-degraded`, `open-gop-leading-pictures-stripped`,
`av1-rung-demoted`, `hw-encoder-selected:*`, `software-fallback:*`.
Every reason carries `{ code, streamIndex?, detail? }`; matrix cases assert on
codes, golden tests on full objects.
`dv-stripped-to-hdr10`'s `detail` is
`dvProfile=<n> blCompatId=<n> elDropped=<bool>` — `elDropped` states whether a
dual-layer profile-7 enhancement layer went with the RPU (LD-15). It rides in
`detail` deliberately: the code list above is CLOSED, additions to it are
contract PRs against `packages/contract/openapi.yaml`'s `PlanReasonCode`, and
`apps/server/test/contract-reason-codes.spec.ts` fails the build in both
directions if the engine and the contract disagree.

`av1-rung-demoted` (LD-7, 2026-08-11 — owner-decision D1 in §7.4; this IS a
closed-enum addition and therefore a contract PR per the rule above) fires
once per ladder rung whose configured/selected `av1` codec was demoted to
`hevc`/`h264` by §7.1's normalization step or §7.2's Stage-G tier-0
software-route guard. `detail` is
`cause=<tier0-no-hw-av1|device-no-av1|no-av1-encoder|tier0-software-route>
demotedTo=<hevc|h264> heightPx=<n>`. It exists because a silent demotion
would violate design law 3's spirit — the admin asking "why is this rung not
AV1?" must get an answer from the plan itself, exactly as
`software-fallback:tier-capped` answers "where did my rungs go?".

## 5. Output contract

```ts
interface PlaybackPlan {
  decision: 'direct-play'|'direct-stream'|'remux'|'transcode';
  reasons: PlanReason[];             // REQUIRED, may be [] only for direct-play
  container: 'source'|'fmp4-hls'|'ts-hls'|'mp4';
  video:    { action:'copy'|'transcode'|'none'; targetCodec?; encoder?; toneMap?: ToneMapMethod; openGop?: boolean };
  audio:    { action:'copy'|'transcode'|'none'; targetCodec?; targetChannels?; targetBitrateBps? };
  subtitle: { strategy:'none'|'embed'|'hls-vtt'|'burn-in'; streamIndex? };
  ladder: LadderRung[];
  ffmpegArgs: string[];              // §6; tokens, not paths
  engineVersion: string;             // semver of decision ruleset, for audit rows
}
```
Serialization for storage/golden tests: `JSON.stringify` with recursively
sorted keys (`stableStringify` in shared).

`video.targetCodec` ranges over `LadderCodec` (§7.1: `'h264'|'hevc'|'av1'`)
— the ENCODE-target set, deliberately narrower than `VideoStream['codec']`'s
source-fact union. The contract mirrors this: `VideoAction.targetCodec`
references the `LadderCodec` schema, not `VideoCodec` (§7.4 — the
LD-7-authorized `VideoAction` touch).

## 6. FFmpeg argument construction (deterministic)

**Canonical segment order (never varies):**
1. Global: `-hide_banner -loglevel warning -nostdin`
2. Input decode accel (backend-specific, §8.3 table)
3. Seek: `-ss {SEEK_SECONDS}` BEFORE `-i` (fast keyframe seek) when present
4. `-i {INPUT}` (+ second `-i {SUBTITLE_SIDECAR}` when external burn-in)
5. Mapping: `-map 0:v:{n}` `-map 0:a:{n}` (+ sub map for embed)
6. Filtergraph (single `-filter_complex` when any of: deinterlace → scale →
   tonemap → subtitle overlay; fixed filter order exactly as listed)
7. Video encode block (codec, preset/quality per backend table, level, GOP:
   `-g {2×fps}` keyframe-aligned to `-force_key_frames expr:gte(t,n_forced*{SEG_DUR})`).
   Video-COPY branch only, added 2026-08-10 (ffmpeg-verified): when
   `video.openGop` is true AND this is a seek-restart (`withSeek: true`) AND
   the container is `fmp4-hls`|`ts-hls`, append `-bsf:v
   filter_units=remove_types=8-9`. CORRECTED SCOPE (opus review Finding E,
   2026-08-10 — the original text above understated this): a `-bsf:v` is a
   PER-INVOCATION filter, not a per-join one — it applies to every packet
   ffmpeg processes for the ENTIRE seek-restarted run, not only the ~20
   leading-picture frames at the seek join. In practice this means every
   GOP for the rest of that invocation loses its own HEVC RASL leading
   pictures (NAL types 8/9) each time it starts, not just the first one at
   the join — a small, PERSISTENT per-GOP frame drop (roughly `bframes`

   frames per keyframe interval) for the remainder of the seek-restarted
   segment run, not a one-time join cost. ACCEPTED TRADE-OFF (owner
   decision, 2026-08-10): this persistent minor frame drop is traded
   against the alternative — a multi-second full-frame decode smear at the
   seek join from undecodable referenceless RASL pictures — and judged the
   better failure mode. A fresh (non-seek) run is unaffected (`withSeek:
   false` never appends the bsf; it starts at the file's true IDR, which
   carries no RASL pictures referencing anything absent). FLAGGED for owner
   QA re-verification of long post-seek playback (does the persistent
   per-GOP drop stay imperceptible over minutes of playback, not just at
   the join) before rc.7 ships.
   **Interpretation L — DOLBY VISION STRIP (LD-3/LD-15, ffmpeg-verified
   2026-08-11 against real DV samples).** Also video-COPY-branch only, and
   emitted whenever `src/dv.ts`'s `dvStripApplies()` holds for the selected
   stream and device (DV profile 7 or 8, `dvBlCompatId` non-null, device
   hdr10-capable, device NOT DV-capable):
   `-bsf:v filter_units=remove_types=62-63` plus `-tag:v hvc1`.
   HEVC UNSPEC62 is the Dolby Vision RPU and UNSPEC63 the dual-layer
   enhancement layer (Rec. ITU-T H.265 Table 7-1 reserves 48-63 as
   unspecified; Dolby's streams spec assigns these two), so removing both
   leaves clean single-layer HDR10. The `-tag:v hvc1` is not cosmetic: a
   real DV source's sample entry is `dvh1`/`dvhe`, a plain copy PRESERVES
   that fourcc, and leaving it would still announce Dolby Vision over a
   bitstream with no DV data left in it.
   *Mechanism chosen by measurement, not preference:* ffmpeg's DV-aware
   `dovi_rpu=strip=1` bsf removes the RPU but leaves EVERY enhancement-layer
   NAL unit behind (all 104 of them on the profile-7 fixture), failing
   LD-15 outright; it also needs ffmpeg ≥ 7.1, whereas `filter_units` long
   predates it and so carries no vendored-build version risk.
   *Composition with interpretation K:* ffmpeg honours only the LAST
   `-bsf:v` for a stream, so when both strips apply they MUST merge into one
   filter_units value — `remove_types=8-9|62-63`. Emitting two flags
   silently discards the open-GOP strip (verified by doing exactly that and
   finding RASL units 8/9 intact). Goldens 35-38 pin all four corners.
   *Not container-gated:* the strip belongs to every repackage, mp4
   download-remux included — and the builder is never called at all for a
   direct-play plan, so reaching it IS Stage C's "repackaging happened"
   condition.
   **Interpretation M — AV1 ENCODE TARGETS (LD-7, spec'd 2026-08-11,
   Wave C1).** The encoder-name table gains its `av1` column (retiring the
   C8 probe/ladder-inconsistency comment that reserved it for this change):
   `software → libsvtav1`, `nvenc → av1_nvenc`, `qsv → av1_qsv`,
   `vaapi → av1_vaapi`, `amf → av1_amf`. `videotoolbox` has NO `av1` entry
   — no ffmpeg release ships an `av1_videotoolbox` encoder (no Apple Silicon
   generation has AV1 encode hardware; decode-only from M3), so the probe
   battery reports the capability absent by construction (§8.1) and Stage G
   can never pair `videotoolbox` with an `av1` target; the builder still
   carries its interpretation-J descriptive throw for the inconsistent
   shape. Per-codec differences inside the existing encode block, all
   deterministic:
   - Software rate/speed flags are PER-ENCODER: `libsvtav1` takes
     `-preset 10` (SVT-AV1's numeric 0–13 scale; ~the realtime-streaming
     band, the libx264-`veryfast` analogue — `veryfast` itself is not a
     legal SVT-AV1 value). `-preset p4` for nvenc is codec-agnostic and
     unchanged; qsv/vaapi/amf emit no preset flag today for any codec and
     that stays true for av1.
   - `-level` is NEVER emitted for an `av1` target in v1: AV1 levels are
     `seq_level_idx` ordinals whose numbering does not correspond to the
     H.264/HEVC decimal levels `DeviceProfile.video[].maxLevel` carries — a
     numerically "mapped" value would be wrong, and every real device
     profile's av1 entry declares `maxLevel: null` today anyway (the web
     client's MSE probe cannot derive one).
   - `-tag:v hvc1` stays hevc-only; an fmp4 AV1 track's `av01` sample entry
     is correct by default and needs no re-tag.
   - Bitrate flags (`-b:v`/`-maxrate`/`-bufsize`), GOP flags (`-g`,
     `-force_key_frames`) and every surrounding segment are codec-agnostic
     and unchanged.
   *Container:* an `av1` rung only ever reaches this builder inside
   `fmp4-hls` (or an `mp4` remux shape, unreachable today) — §7.1's device
   gate refuses AV1 targeting for `ts-hls` devices (AV1 has no assigned
   MPEG-TS stream_type; muxing it there produces a stream nothing
   standard can demux). An `av1` rung paired with `ts-hls` is an
   internally-inconsistent planShape → interpretation-J descriptive throw,
   never reachable through `plan()`.
8. Audio encode/copy block
9. Output: HLS muxer flags — `-f hls -hls_time {SEG_DUR} -hls_playlist_type
   event -hls_segment_type {fmp4|mpegts} -hls_fmp4_init_filename init.mp4
   -start_number {START_SEG} -hls_segment_filename {SESSION_DIR}/s%06d.m4s
   {SESSION_DIR}/media.m3u8`
**Tokens** (`{INPUT}`,`{SESSION_DIR}`,`{SEEK_SECONDS}`,`{START_SEG}`,`{SEG_DUR}`)
are substituted by the session layer — the pure engine never sees real paths.
Golden-file tests snapshot the token form. Flag values derive only from plan
inputs; any new flag requires a golden update in the same PR.

## 7. Bitrate ladder

`LadderRung { heightPx, videoBitrateBps, audioBitrateBps, codec: LadderCodec }`
where **`LadderCodec = 'h264' | 'hevc' | 'av1'`** (§7.1, LD-7) — the closed
set of codecs a rung may ENCODE to, a different concept from
`VideoStream['codec']`'s source-fact union and deliberately narrower.
Instance default table (policy-overridable):
2160p/16M/hevc · 1080p/8M · 1080p/4M · 720p/3M · 480p/1.5M · 360p/0.8M
(h264 below 2160 unless codec selection (§7.1) upgrades a rung).
Construction rules: never exceed source height; never exceed source bitrate;
drop rungs above `network.maxBitrateBps` (keep at least the lowest rung);
master playlist lists all surviving rungs; **each rung is a lazily started
transcode pipeline** — only the initially selected rung starts; a client ABR
switch starts the sibling rung at the requested segment. `isLocal` networks
skip the network cap but honor device caps.

### 7.1 Per-rung codec selection (LD-7, spec'd 2026-08-11 — lands as ENGINE_VERSION 0.10.0)

Step (f) of ladder construction (`stages/ladder.ts`, formerly "the hevc
swap") generalizes to ONE codec-selection step with fixed precedence
**av1 > hevc > h264**, still applied BEFORE the cap filters (a)–(e)
(swap-before-caps is unchanged and now covers demotion too: the rung the
client actually receives is the one every cap must evaluate).

**AV1 swap.** A table rung with `heightPx < 2160` becomes
`{ codec: 'av1', videoBitrateBps: round(table videoBitrateBps × 0.6) }`
(`audioBitrateBps` unchanged) IFF ALL of:
1. `policy.av1EncodePreferred` (operator opt-in, §2.4 — default false);
2. the DEVICE declares an `av1` entry in `device.video` (the web client's
   MSE probe already produces one when real decode support exists) AND
   `device.hls.supportsFmp4` (AV1 cannot ride `ts-hls` — §6 interp. M);
3. `av1EncodeEligibility(caps, policy.tier) !== 'none'` (§7.2 — the LD-16
   gate, and the ONLY place capability/tier is consulted).
The ×0.6 factor is the h264-baseline bitrate-parity convention one
generation past hevc's documented ×0.75 (owner-decision D3, §7.4). The
2160p rung is untouched by the swap exactly as it always was for hevc —
a 2160p AV1 rung is expressible as an explicit policy rung. Rungs the AV1
swap does not claim fall through to the hevc rule VERBATIM
(`hevcEncodePreferred` and device hevc → hevc, −25% bitrate, below 2160).
*Tier-0 lens:* on Tier-0 the swap can only ever fire via `'hw'`
eligibility (§7.2); on an N100-class box — QSV AV1 decode but NO AV1
encode engine — the produced ladder is byte-identical to pre-C1.

**Demotion normalization (new step (g), runs after (f), before (a)–(e)).**
Any rung whose codec is `'av1'` at this point — which can ONLY mean an
explicit `policy.ladderRungs` row, since the swap already checks these
gates — is DEMOTED when it fails condition 2 or 3 above (condition 1
deliberately does NOT apply: an explicit av1 rung IS the operator's
preference for that rung; the global flag only governs the automatic
swap): `codec` becomes
`'hevc'` if `device.video` declares an hevc entry, else `'h264'`;
`videoBitrateBps` is kept VERBATIM (the admin chose that number; inventing
a scaled one would guess). A demoted rung that becomes field-identical to
another table rung is dropped instead of duplicated. Each demotion fires
informational reason `av1-rung-demoted` (§4). Demote-don't-drop is
deliberate: dropping could empty a configured ladder or silently discard
the admin's quality point; demotion keeps the rung count and heights
stable on every box.
*Tier-0 lens:* an admin who force-writes av1 rungs into a T0 box's table
gets the same ladder shape encoded by the machine's REAL encoders (QSV/
software h264/hevc on an N100) — a serveable plan, never a melted box.

**Copy-preference guarantee (LD-7 hard requirement).** Everything in §7.1/
§7.2 lives exclusively in ladder construction and Stage G — both reachable
ONLY when the final `video.action === 'transcode'`. No Stage A–F verdict
reads a ladder codec; an AV1 SOURCE continues to direct-play/copy exactly
as §3 already decides (Stage B's device check, Stage A's container check —
unchanged). Regression pin required in the C1 PR: for every existing
matrix case whose decision is `direct-play`/`direct-stream`/`remux`,
decisions AND reasons are byte-identical post-C1 (`engineVersion` aside).

### 7.2 AV1 tier gating — LD-16 verbatim law and the unreachability property

The law (LD register, owner-adjudicated 2026-08-10, restated here as
normative spec text): **every quality rung is a separate workload governed
by the existing admission capacity limit (§9 semaphore); a quality change
hands the existing slot from one rung to another — never an additional
unrestricted transcode. AV1 on Tier-0 is permitted ONLY when supported
hardware encoding is verified by the probe battery; Tier-1 and above may
fall back to software AV1 encoding.** (Tier-0's advertised variant COUNT
is Wave C2's to propose; nothing in C1 changes admission arithmetic.)

**The single gate.** `src/av1.ts` (new pure module, mirroring `src/dv.ts`'s
shared-predicate precedent) exports:

```ts
av1EncodeEligibility(caps: VerifiedCapabilities, tier: 0|1|2):
    'hw' | 'software' | 'none'
// 'hw'       iff some backend b with b.backend !== 'software' has 'av1' in b.encode
// 'software' iff not 'hw', AND tier >= 1, AND the software backend's
//            own probe-verified encode list includes 'av1'
// 'none'     otherwise
```

plus the shared demotion primitive §7.1(g) and Stage G both call. Both
consumers use THIS function and nothing else — one predicate, so the
ladder's admission rule and Stage G's guard cannot drift apart
(structurally, the LD-3 lesson).

Note the `'software'` arm is itself capability-VERIFIED (design law 4):
it reads the software row's probe-verified encode list, which §8.1 only
populates when the bundled build's `libsvtav1` actually passed the encode
self-test on this box — "software can av1" is a tested fact, never an
assumption.

**Stage G residual guard.** `'hw'` eligibility admits av1 rungs, but §8.3's
route resolution can still terminate at rule (iii) full-software (e.g. the
av1-capable hw backend fails encode coverage for a mixed
`{av1, hevc}` target set). On that rule-(iii) route ONLY, when
`policy.tier === 0`: every av1 rung in the routed ladder is demoted by the
§7.1(g) shared primitive (reason `av1-rung-demoted`,
`cause=tier0-software-route`) BEFORE the existing ≥1080p height cap runs.
Tier 1+ rule-(iii) routes keep their av1 rungs (that IS the permitted
software fallback) — the builder then encodes them with `libsvtav1`
(§6 interp. M). Known conservatism, stated not hidden: a T0 box whose hw
backend covers av1 but not hevc lands on software h264/hevc rather than
splitting encode across two backends — §8.3's one-route model is not
renegotiated by this feature.

**UNREACHABILITY (the LD-16 proof obligation — §10 property 5).** On
Tier-0 without a probe-verified HARDWARE AV1 encoder, `plan()` is UNABLE
to emit software-AV1 **by construction**, argued in four steps a test can
mirror:
1. The only producers of an av1 rung are §7.1(f)'s swap (gated on
   eligibility ≠ `'none'`) and explicit policy rows, which §7.1(g)
   normalizes under the SAME predicate → `buildLadder` output contains no
   av1 rung when eligibility is `'none'`.
2. On tier 0, eligibility is `'hw'` or `'none'` — the `'software'` arm
   requires `tier >= 1` by definition → tier-0-without-hw-av1 ⇒ `'none'`
   ⇒ no av1 rung exists anywhere downstream.
3. `video.targetCodec` derives exclusively from the final ladder's top
   rung, and the builder's av1 encoder names are keyed exclusively off a
   rung/targetCodec of `'av1'` → no av1 rung ⇒ no av1 targetCodec ⇒ no
   av1 encoder name in `ffmpegArgs`.
4. The one remaining pairing — tier-0 `'hw'` eligibility whose route
   resolution still lands on software — is closed by the Stage G residual
   guard above, via the same shared primitive.
Therefore no Tier-0 plan can pair `codec/targetCodec === 'av1'` with
software encoding. §10 property 5 quantifies this over randomized inputs;
dedicated matrix cases pin each numbered leg.

**Tier-0 arithmetic (why the law is a law, not a tuning preference —
N100/4GB reference box).** An N100 (4 Gracemont E-cores, ~6 W, UHD iGPU)
has Quick Sync AV1 DECODE but NO AV1 encode engine (AV1 hw encode begins
with the DG2/Arc generation), so its probe verifies `qsv: decode ∋ av1`,
`encode ∌ av1` → eligibility `'none'` on T0, always. What the gate
prevents: SVT-AV1 at its realtime-band presets reaches 1080p realtime on
roughly 8 modern performance cores; four E-cores deliver a small fraction
of that — order 0.2–0.4× realtime, i.e. a 6-second segment costs ~15–30 s
to encode. The §9 segment-ahead throttle never engages (the encoder never
GETS ahead); the playhead overruns the encoder inside the first minute and
every playback stalls unrecoverably, while all four cores sit pegged —
starving Postgres, server, and worker on the same 4 GB box (SVT-AV1's
1080p working set alone runs several hundred MB to ~1 GB beside their
~1.5–2 GB resident set: OOM territory, not merely slow). A permanently-
behind encoder is the worst possible violation of design law 5 — hence
`'none'`, by construction, with the escape hatch being real hardware, not
a checkbox.

### 7.3 The probe battery is the gating input (C8 closure)

The `'av1' ∈ backend.encode` facts §7.2 consumes are produced ONLY by the
§8.1 self-test battery (`apps/worker/src/hwcaps/`), which has verified AV1
encode capability since it landed — previously with no consumer, the
recorded C8 probe/ladder inconsistency ("hwprobe can report a box
AV1-encode-capable with no way for a plan to act on that fact"). §7.1/§7.2
are that consumer; the C8 tracking comment at the engine's
`VIDEO_ENCODER_NAMES` retires in the same PR that adds the table's av1
column (§6 interp. M). Two battery refinements ship with C1:
- **Software AV1 capability narrows to `libsvtav1`** (owner-decision D4,
  §7.4): the software row's av1 ENCODE test runs against `libsvtav1` only
  — a box whose ffmpeg has only `libaom-av1` reports software-av1 encode
  ABSENT. Rationale: libaom's realtime presets are not a viable streaming
  encoder, and a capability the builder cannot deterministically name is
  not a capability (§6 emits ONE fixed encoder name; probe-verifying the
  exact encoder the builder will spawn is the same
  probe-proves-the-shipped-plumbing rule interp. D already follows for
  tone-mapping). Costless on shipped builds: every fetchable vendored
  ffmpeg (linux-x64, linux-arm64, macos-arm64 — verified 2026-08-11,
  build-config/`-encoders` inspection; windows-x64 pending CI
  confirmation) compiles `--enable-libsvtav1`. `libaom-av1` keeps its
  existing role generating av1 DECODE-test sources (speed is irrelevant
  there and `resolveSoftwareAv1Encoder`'s fallback order stays for that
  path).
- **`videotoolbox` av1 encode stays skip→absent by construction** (no
  `av1_videotoolbox` encoder exists in any ffmpeg; no Apple Silicon has
  AV1 encode hardware) — already true in `tables.ts`, now load-bearing:
  it is what makes the Tier-0 refusal path REALLY verifiable on the
  project's own Apple Silicon hardware (§7.4 honesty register).

### 7.4 C1 change register (contract surface, coordination, owner decisions)

**Contract (`packages/contract/openapi.yaml`) — the COMPLETE list; SDK
regenerated atomically; conformance unimplemented-allowance stays zero:**
1. `LadderCodec` enum: `[h264, hevc]` → `[h264, hevc, av1]`.
2. `VideoAction.targetCodec`: `$ref VideoCodec` → `$ref LadderCodec` (the
   LD-7-authorized touch of the `additionalProperties:false` schema Wave A
   deliberately avoided; narrows the contract to the exactly-emittable
   set — `VideoCodec` had admitted `vp9`/`mpeg2`/… as targets no engine
   version ever produced).
3. `PlanReasonCode` fixed informational list: += `av1-rung-demoted`
   (owner-decision D1; `apps/server/test/contract-reason-codes.spec.ts`
   enforces engine/contract agreement in both directions).
Empirical oasdiff preview (run 2026-08-11 against these exact edits):
**0 errors, warnings only, exit 0 — gate-passing.** Warnings are
`response-property-enum-value-added` for the ladder codec at
`POST /playback/plan` 200, `POST /playback/sessions` 201,
`GET /playback/sessions/{id}` 200 (plus the same trio for the D1 reason
code). The `targetCodec` re-point produces NO oasdiff finding (response
narrowing). No other schema changes: `VideoCodec`, `AudioCodec`,
`MediaInfo`, `DeviceProfile`, capability shapes — all untouched.

**Coordinated single-change surface (one PR; matrix + goldens included per
invariant 2):** engine `src/av1.ts` (new), `src/types.ts`
(`LadderCodec`; `LadderRung.codec`; `PlaybackPlanVideo.targetCodec`),
`src/stages/ladder.ts` (§7.1 f/g), `src/stages/hardware.ts` (target-set
type + §7.2 residual guard), `src/args/builder.ts` (§6 interp. M;
C8 comment retires), `src/reasons.ts` (D1), `src/plan.ts`
(ENGINE_VERSION 0.10.0), matrix generators/fixtures/cases + goldens;
contract per the list above + SDK regen;
`packages/shared/src/settings-registry.ts` (`LADDER_RUNG_CODECS` += av1,
`transcode.ladderRungs` copy, NEW `transcode.av1EncodePreferred` setting —
default false, no envVar, docs regen per the settings-registry rule);
`apps/server/src/playback/resolve-policy.ts` (verbatim preference
pass-through, §2.4 note); `apps/worker/src/hwcaps/args.ts` + `tables.ts`
(D4 narrowing). **DB: NO change and NO migration** — verified 2026-08-11:
the only codec CHECK constraints in the schema
(`hw_capability_backends.decode/encode`, migration 0011) were born
av1-inclusive, and no real column stores a ladder/target codec (plans are
whitelisted JSONB; `transcode_runs` carries no codec) — the LD-7
register's "DB CHECK" line item closes as already-satisfied.

**Owner decisions requested at the C1 stop (each reversible by a small
text edit here):**
- **D1** — add informational reason `av1-rung-demoted` (recommended: YES;
  the alternative — silent demotion, visible only structurally in the
  ladder — leaves design law 3's "why is this transcoding like this?"
  unanswerable for AV1).
- **D2** — re-point `VideoAction.targetCodec` to `LadderCodec`
  (recommended: YES; zero-oasdiff, makes the contract state the truth;
  alternative: leave as `VideoCodec` — av1 was technically already legal
  there, and C1 then touches `VideoAction` not at all).
- **D3** — AV1 swap bitrate factor ×0.6 of the h264 table value, swap
  scope sub-2160 only (mirrors hevc precedent).
- **D4** — software-AV1 capability = `libsvtav1` only (§7.3).
- **D5** — `transcode.av1EncodePreferred` defaults FALSE (opt-in;
  flippable per-instance from the settings UI at any time).

## 8. Hardware acceleration

### 8.1 Verification self-tests (worker, first boot + `loombre probe` + driver change)
For each candidate backend on the platform: run bundled ffmpeg against
generated `lavfi testsrc2` inputs — (a) decode test per codec (2 s clip,
assert frame count), (b) encode test per codec (assert valid bitstream via
re-probe), (c) tone-map test (HDR10 synthetic → SDR, assert output transfer).
Timeout 20 s per test; any failure or timeout = capability absent. Results →
`VerifiedCapabilities`, persisted with ffmpeg build hash; invalidated when the
bundled ffmpeg or GPU/driver fingerprint changes. Known quirk regressions
(e.g. iHD VDENC low-power gaps) are just failed self-tests — no quirk lists.

**AV1 encode specifics (LD-7, §7.3):** the battery has always tested av1
encode per backend; as of C1 its result is load-bearing (§7.2 reads it).
Two rules: the SOFTWARE row's av1 encode test runs `libsvtav1` ONLY
(owner-decision D4 — a libaom-only build reports software-av1 encode
absent; libaom keeps generating av1 decode-test sources); a backend whose
ffmpeg simply lacks the encoder (`videotoolbox` — no `av1_videotoolbox`
exists) is skipped→absent by construction, never a failed spawn.

### 8.2 Backend candidates by platform
macOS: videotoolbox → software. Windows: nvenc → qsv → amf → d3d11va(decode-
only) → software. Linux: nvenc → qsv → vaapi → software.

**Arch pruning (LD-2).** The rows above are keyed on platform AND
architecture. The Windows row is an x86 row: nvenc, qsv and amf are all
x86-vendor facts, and d3d11va only LOOKS architecture-neutral — its ARM64
Windows path runs against drivers nobody in this project has probed, and an
unverified hwaccel fails mid-session after the plan is already committed.
**Windows on arm64 → `software` only.** macOS and Linux on arm64 are
unchanged (Apple Silicon videotoolbox is the primary Mac target; Linux arm64
vaapi/nvenc are real). Re-open condition, and the only one: a real probe-
battery PASS for d3d11va decode on real ARM64 Windows hardware, recorded in
STATE.md.

### 8.3 Selection & pipelines
Choose the first backend (platform order) whose VERIFIED caps cover BOTH the
required decode codec and target encode codec; else first covering encode with
software decode (`software-fallback:decode`); else full software
(`software-fallback:encode`) — gated on tier: T0 full-software transcode of
≥1080p sources → allowed only for the ≤480p rungs, higher rungs dropped with
reason `software-fallback:tier-capped`. Tone-map method preference per
backend: videotoolbox→`videotoolbox`; nvenc→`cuda`; qsv/vaapi→`opencl`(else
`vulkan`); software→CPU zscale only if `allowToneMapCpu` resolves true.
Decode/encode stay on one device (no hw→sw→hw bounces) except when the
filtergraph requires download (subtitle burn-in on vaapi: hwdownload →
overlay → hwupload, exactly once).

**AV1 targets (LD-7).** The target-encode-codec set may now include `av1`
(§7.1); selection SHAPE is unchanged — a backend must still cover EVERY
distinct target codec, av1 included, and `videotoolbox` can never be
selected for an av1 target (§8.1: the capability is absent by
construction). ONE addition, on the rule-(iii) full-software route only:
when `policy.tier === 0`, every av1 rung in the routed ladder is demoted
via `src/av1.ts`'s shared primitive (reason `av1-rung-demoted`,
`cause=tier0-software-route`) BEFORE the existing ≥1080p tier cap — the
Stage-G half of §7.2's unreachability construction. Tier 1+ software
routes keep av1 rungs: that is LD-16's permitted software fallback, and
the builder encodes them with the probe-verified `libsvtav1` (§6 M, §8.1).
*Tier-0 lens:* this guard is the last line — even the pathological
hw-av1-verified-but-software-routed corner cannot put an SVT-AV1 encode
on an N100-class box.

## 9. Session execution layer (apps/server playback module + worker)

State machine: `created → starting → active ⇄ suspended → seeking → active …
→ ended | failed(errorCode)`.
- **Start:** plan tokens substituted; session dir under transcode staging
  (NVMe path from config); first playlist request blocks ≤ 8 s for init +
  first segment, else 503-retry-after (client shows buffering).
- **Segment-ahead throttle:** monitor produced-vs-requested segment index;
  when ahead > 10 segments (60 s), suspend encode (SIGSTOP on the ffmpeg
  process group; resume with SIGCONT at ahead ≤ 5). Throttling is mandatory
  — a T0 box must never spend CPU racing ahead of a paused viewer.
  - **POSIX (darwin/linux):** the above, literally — real SIGSTOP/SIGCONT
    (`apps/worker/src/transcode/process.ts`), the session row carrying
    `suspended_by_throttle = true` while stopped.
  - **Windows:** NOT process suspension. Job-object suspension
    (`NtSuspendProcess`) needs a native addon, and this project ships no
    new native dependency for it (P3.8). The shipped mechanism is
    **`-readrate` pacing**: every win32 ffmpeg run is spawned with
    `-readrate 1.2` injected into its global-options segment
    (`apps/worker/src/transcode/args.ts` `injectReadrate`,
    `WIN32_READRATE_MULTIPLIER` in `throttle.ts`), pacing the encode at
    ~1.2× realtime so it structurally never races far enough ahead to need
    suspending. Behavioral consequence, stated rather than hidden: a win32
    worker never SIGSTOPs anything and never writes
    `suspended_by_throttle = true` — `reconcileThrottle` returns
    `{ action: 'none' }` whenever the mechanism is `readrate`. Swapping a
    real suspension helper in later changes only
    `throttleMechanismForPlatform`'s win32 branch; the reconciliation table
    is mechanism-agnostic and does not move.
- **Seek:** target inside produced range → serve. Outside → kill pipeline,
  restart with `{SEEK_SECONDS}=target` and `{START_SEG}` continuing the
  numbering, playlist gains `EXT-X-DISCONTINUITY`. Old segments beyond a
  retention window (120 s behind live edge) are deleted.
  - **"Outside" is decided per segment GET** (apps/server's
    `hls-file.controller.ts`): the requested index is more than 3 ahead of
    `produced_segment`, OR the file is simply not on disk (a run that has
    not reached that number yet, or a retention-pruned one). Either way the
    response is 503 + `Retry-After`, never 404 — a 404 makes hls.js treat
    the segment as permanently gone instead of "coming after a restart".
  - **Seek-target derivation (MANDATORY — never nominal arithmetic).** The
    ms value written to `seek_target_ms` is derived from the durations the
    session ACTUALLY produced: the `#EXTINF` values in the served
    `media.m3u8`. `segmentIndex × segmentDurationSec × 1000` is wrong by
    construction — `-hls_time {SEG_DUR}` is a lower bound and
    `-force_key_frames expr:gte(t,n_forced*{SEG_DUR})` (§6) cuts at the
    first keyframe AT OR AFTER each mark, so a real segment overshoots and
    the error compounds with the index (tens of seconds by mid-feature; a
    seek then lands somewhere the viewer did not ask for, and a second seek
    compounds it again). The rule, in order:
      1. no served playlist readable → `index × segmentDurationSec × 1000`
         (LAST resort only — there is nothing measured to reason from);
      2. index at/after a listed entry → exact cumulative sum of the real
         durations before it, anchored at `firstListedIndex × mean`;
      3. index before every listed entry (backward seek into the pruned
         head) → `index × mean`;
    where `mean` is the measured mean of every listed segment. Rule 2 is
    EXACT whenever the playlist still starts at index 0 — the anchor is
    `0 × mean` and nothing is estimated.
  - **Per-run source anchoring (EXACT for every run).** The rules above are
    a presentation-timeline answer, and presentation only equals source for
    run 0. With `transcode_runs` (migration 0043) the derivation resolves
    the segment's OWNING RUN and computes
    `run.source_origin_ms + Σ(real #EXTINF of that run's OWN segments from
    run.start_segment up to index-1)`. Inside one run, playlist duration
    maps 1:1 to source time — neither a copy nor a transcode changes the
    rate — so this is exact for every run. Only that run's own segments are
    summed; a previous run's durations describe a different region of the
    source entirely. Segments of the run already pruned out of the playlist
    are the single estimated term, and they extrapolate at THAT RUN's own
    measured mean. **Run ownership follows the segment counter, never the
    clock:** a backward seek starts a later run at an EARLIER
    `source_origin_ms`, so the origin is not monotonic across runs and
    `start_segment` is the only key that is. A session with no recorded runs
    keeps the playlist-only chain above — "no anchor available" must never
    be read as "origin 0".
  - **`EXT-X-MEDIA-SEQUENCE` is MANDATORY once retention has pruned.**
    Retention deletes segments from the FRONT of the served playlist, and
    RFC 8216 §4.3.3.2 reads an absent media-sequence tag as 0 — "the first
    segment listed is segment number 0". Without the tag every prune
    silently renumbers the playlist from the client's point of view, and
    hls.js derives each fragment's `sn` (and the media-time offset it maps
    a seek to) from that base. Because this layer numbers segments
    absolutely and continuously across every seek-restart run, the first
    surviving segment's own index IS the media sequence number — the server
    adds `#EXT-X-MEDIA-SEQUENCE:<firstIndex>` when, and only when,
    `firstIndex > 0`. An unpruned playlist stays byte-identical.
  - **Clamp:** the derived target is clamped to `[0, durationMs]` at the
    controller before `requestSeek`. `requestSeek` itself writes
    `seek_target_ms` verbatim by design (it never re-derives a decision its
    caller made), so the clamp belongs to whoever decides the target. An
    unclamped value becomes an ffmpeg `-ss` past EOF: a restart that
    produces nothing, forever. An unprobed file (no `durationMs`) keeps the
    lower bound only.
- **Heartbeat:** client progress PUT doubles as heartbeat; no heartbeat for
  90 s → suspend; 15 min → end session, delete dir, emit `playback.ended`.
  - **Reported positions are PRESENTATION time; stored positions are SOURCE
    time.** A player reports `video.currentTime`, its position in the served
    playlist's timeline — which runs continuously across every
    `EXT-X-DISCONTINUITY`. Each seek run is spawned with `-ss` and no
    `-copyts`, so its own output timestamps restart at zero, and the two
    timelines diverge by exactly the accumulated seek offsets. Progress,
    resume points and `positionMs` everywhere else in this system are
    source-timeline values, so a post-seek heartbeat stored verbatim points
    at the wrong place in the file.
  - **The conversion is server-side, at ingestion** (`PUT /progress/{itemId}`
    when it carries a `sessionId`). The client is left alone: it reports
    what its media element knows, and only the server holds the run map
    (`transcode_runs`) and the served playlist needed to reconcile them.
    The mapping walks the playlist to find the segment containing the
    reported position, then re-expresses it in that segment's OWN run:
    `source = owningRun.source_origin_ms + (offset of the segment within
    its run) + (how far into the segment the position sits)`. The
    within-segment remainder carries through unchanged for the same reason
    the offsets do — inside a run, presentation and source advance at the
    same rate.
  - **It never guesses.** No sessionId, no staging dir, no runs, an
    unreadable playlist, or a position past the playlist's end all keep the
    client's value exactly as sent. That value is already correct for every
    direct-play session and every transcode session that has not seeked, so
    declining to map is always safe; a wrong guess would silently corrupt a
    resume point.
- **Concurrency:** global semaphore = `maxSimultaneousTranscodes`; admission
  beyond it fails the session create with a typed 429 (`transcode-slots-
  exhausted`) — clients fall back to a lower-bitrate direct attempt or queue.
- **Audit:** the serialized plan + engineVersion stored on the session row at
  create; ffmpeg stderr tail (last 4 KB ring) stored on failure.
- **Process lifecycle (no orphaned encoders).** Runs are spawned detached on
  POSIX so the whole process group can be signalled, which also means they do
  not die with their worker. Two mechanisms close that: (a) the worker's
  graceful shutdown terminates every in-flight run before stopping the queue
  (SIGCONT-then-SIGTERM, so a throttle-suspended run dies promptly rather than
  sitting on a pending signal); (b) a crash — SIGKILL/OOM/power cut, where no
  shutdown code runs — is cleaned up at the NEXT worker boot: each run's pid
  and its supervising worker's start time are persisted on the session row,
  and the boot reaper kills any process still alive from a previous worker
  generation, verified by pid **and** command line against that session's
  staging dir (a pid alone is never enough — pids are reused). A live run
  whose supervisor died is an orphan by definition: nothing remains to
  throttle, seek, or end it. The admission slot is released only after the
  process is confirmed gone, so a freed slot never sits on top of a running
  encoder. Boot reconciliation covers the `transcode` job ledger under
  session-lifetime horizons, and the heartbeat sweeper logs a warning when it
  ends a session that still names a live pipeline.
- **Redundant seek requests are absorbed, not obeyed.** A client retrying a
  503-retry-after makes the server record the same seek target repeatedly.
  The worker restarts only for a target the in-flight run is not already
  serving — outside `[run origin, run origin + produced]`, or with that run
  already exited; a repeat of what is being produced is cleared without a
  restart, without a discontinuity, and without a status change. Obeying each
  repeat killed the run before it could produce its first segment, so the
  client never stopped retrying: a livelock that burned the most expensive
  part of a run indefinitely. A genuinely different target — including a
  backward one — still restarts. Once retention has pruned the head of the
  in-flight run, matching narrows to the run's exact origin, since the rest
  of its window is no longer on disk.
- **Every run records its source origin.** Segment indices are one global
  counter across a session's runs, while each seek run's own output timeline
  restarts at zero (`-ss`, no `-copyts`). Each spawned run therefore persists
  its run index, the segment index it starts numbering at, and where it begins
  in SOURCE time — so a served segment index can be mapped back to a real
  source position. Ownership of an index follows the segment counter, never
  the source clock: a backward seek starts a later run at an earlier origin,
  so source origin is not monotonic across runs.
- **Direct-play** sessions bypass all of this: range-request file serving with
  progress heartbeats only.

## 10. Test matrix requirements (Phase 3 exit ≥ 500 cases)

Dimensions (coverage minimums): video codec {h264,hevc,av1,vp9,mpeg2} ×
bitDepth {8,10} × hdr {none,hdr10,hlg,dv5,dv8.1} × interlaced ·
audio {aac,ac3,eac3,truehd,dts,flac,opus} × channels {2,6,8} ×
passthrough {y,n} · subtitle {none,srt,ass,pgs,vobsub,external-srt} ·
container {mp4,mkv,ts,avi} · device profiles {web-chrome, web-safari,
constrained-tv (h264-only 1080p SDR 2ch), mobile-placeholder} ·
network {local, 20M, 4M, 1M} · policy {T0 defaults, T2 defaults,
transcode-disabled}.
**Mandatory property tests:** (1) determinism — 1,000 random valid inputs,
plan twice, byte-equal; (2) direct-play bias — construct inputs where every
stage passes, assert decision===direct-play and reasons===[]; (3) totality —
random inputs never throw, always yield schema-valid plans; (4) reason
completeness — decision!==direct-play ⇒ ≥1 blocking-class reason;
(5) **AV1 tier-0 unreachability (LD-16, §7.2)** — over randomized inputs
(generators extended to produce av1-preferring policies, explicit-av1
ladder tables, and av1-bearing caps in all combinations) restricted to
`policy.tier === 0` AND no non-software backend with `'av1' ∈ encode`:
NO emitted plan contains a ladder rung with `codec === 'av1'`, a
`video.targetCodec === 'av1'`, or any `ffmpegArgs` token naming an av1
encoder (`libsvtav1`, `av1_nvenc`, `av1_qsv`, `av1_vaapi`, `av1_amf`).
**C1 mandatory matrix case classes (numbers assigned at build; each of
§7.2's four unreachability legs pinned individually):** T0 + hw-av1 caps +
opted-in policy + av1/fmp4 device → av1 rungs, hw route; T0 +
software-only-av1 caps → zero av1 anywhere; T1 + software-only-av1 caps →
av1 rungs on the software route (`libsvtav1` args); explicit-av1 policy
rung demoted on each `cause` (device-no-av1, no-av1-encoder,
tier0-no-hw-av1); T0 `'hw'`-eligibility mixed-target set falling to rule
(iii) → Stage-G demotion; ts-hls-only device → no av1 swap; av1 SOURCE
copy/direct-play cases unchanged (the §7.1 regression pin).
**Golden args:** 25 canonical scenarios snapshot full token-form ffmpegArgs
(count grows with each landed interpretation; C1 adds at minimum: hw-av1
transcode (`av1_nvenc`), software-av1 T1 transcode (`libsvtav1 -preset
10`, no `-level`, no `-tag:v`), and a demoted-ladder scenario).
**Regression law:** any PR flipping an existing case's decision or reasons
must edit that case file in the same PR with a `why:` comment.
**Session integration tests** (not pure): real ffmpeg against generated
fixtures (testsrc2-derived, checked in as a generator script, not binaries):
start→first-segment latency, seek-restart numbering, throttle suspend/resume,
heartbeat teardown — run on all three OS CI runners.

## 11. Phase 3 implementation order (the orchestration prompt will encode this)

1. Types + reasons + stableStringify + matrix runner upgrades (property-test
   harness) — everything red.
2. Stages A→F one at a time, each landing with its dimension's matrix cases
   (target ~60–80 cases/stage), direct-play-bias property green from stage A.
3. Ladder + Stage G against a FAKED VerifiedCapabilities fixture set.
4. Arg builder + 25 goldens.
5. Hardware self-test probe (worker) on real machines: your T2 Linux box
   (NVENC+QSV paths), the M3 Max (VideoToolbox), Windows runner (NVENC/AMF).
6. Session layer + integration tests; wire `/playback/plan` and session
   endpoints to the engine; conformance stays green throughout.
Each step is a STATE.md freeze boundary; the matrix count is tracked in
STATE.md as a burn-up, not vibes.
