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
`av1-rung-demoted`, `ladder-variant-capped`, `hw-encoder-selected:*`,
`software-fallback:*`.
Every reason carries `{ code, streamIndex?, detail? }`; matrix cases assert on
codes, golden tests on full objects.
`dv-stripped-to-hdr10`'s `detail` is
`dvProfile=<n> blCompatId=<n> elDropped=<bool>` — `elDropped` states whether a
dual-layer profile-7 enhancement layer went with the RPU (LD-15). It rides in
`detail` deliberately: the code list above is CLOSED, additions to it are
contract PRs against `packages/contract/openapi.yaml`'s `PlanReasonCode`, and
`apps/server/test/contract-reason-codes.spec.ts` fails the build in both
directions if the engine and the contract disagree.

`ladder-variant-capped` (LD-6/LD-16, Wave C2 — owner-decision V2 in §9.1.11;
a closed-enum addition and therefore a contract PR per the rule above) fires
ONCE per plan when §7.5's Tier-0 advertised-variant cap trims the final
ladder. `detail` is `cap=<n> dropped=<heightPx>p@<videoBitrateBps>[,…]`
(e.g. `cap=3 dropped=1080p@8000000,720p@5000000`) — one reason listing
every dropped rung comma-joined in table order, not one per rung, because
the cap
is a single decision with a single cause (contrast `av1-rung-demoted`,
which is per-rung because each rung demotes for its own cause). It exists
for the same design-law-3 duty: the admin asking "why does this box
advertise 3 qualities when the table has 6?" must get the answer from the
plan itself.

`av1-rung-demoted` (LD-7, 2026-08-11 — owner-decision D1 in §7.4; this IS a
closed-enum addition and therefore a contract PR per the rule above) fires
once per ladder rung whose configured/selected `av1` codec was demoted to
`hevc`/`h264` by §7.1's normalization step or §7.2's Stage-G software-route
guard (tier-0 always; tier-1+ when the software row lacks probe-verified
av1 — the rule-(iii) clause). `detail` is
`cause=<tier0-no-hw-av1|device-no-av1|no-av1-encoder|tier0-software-route|software-route-no-av1>
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
3. Seek: `-ss {SEEK_SECONDS}` BEFORE `-i` (fast keyframe seek) when present.
   **Interpretation N — `-noaccurate_seek` on mixed copy/transcode
   seek-restarts (V8 live-QA fix, ffmpeg-verified 2026-08-20).** When
   `withSeek` is true AND at least one selected stream is COPIED while
   another is TRANSCODED, `-noaccurate_seek` immediately precedes `-ss`.
   Why: ffmpeg's accurate input seek trims DECODED (transcoded) streams at
   the exact target, but a copied stream can only begin at the preceding
   keyframe — so a mixed restart otherwise opens with a leading HOLE in
   the trimmed track, up to a full GOP wide (measured 555 ms on the live-QA
   file: 4K HEVC copy + eac3→opus, seek 6177.232 s → first audio pts 0.638
   vs first video pts 0.083). The hole stalls MSE playback at the
   hard-seek landing and skews A/V by its width for the rest of the run.
   With the flag, every stream starts together at the demuxer's keyframe
   snap point (measured ≤5 ms apart) — inside §9.1.5 rule 7's documented
   ≤1-GOP PDT keyframe-snap bound, so no other part of V8 moves. When BOTH
   tracks transcode the flag is OMITTED: accurate trim aligns both at the
   exact target AND keeps the run's PDT origin exact — strictly better.
   All-copy restarts emit it harmlessly (copy never trims), keeping the
   rule a plain "any copied stream". Goldens 25/33/36/42 carry the flag;
   golden 43 pins the live-QA shape itself.
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
   - `-b:v` and `-bufsize` are codec-agnostic, but **`-maxrate` is OMITTED
     for the SOFTWARE av1 target**. CORRECTED BY EXECUTION (2026-08-11,
     build lane, SVT-AV1 v4.1.0 — this bullet originally read "bitrate
     flags (`-b:v`/`-maxrate`/`-bufsize`) … are codec-agnostic and
     unchanged", and running it disproved that): ffmpeg's `libsvtav1`
     wrapper reads `bitrate == maxrate` as CBR, and SVT-AV1 refuses both
     the max-bitrate setting and CBR outright for its RANDOM_ACCESS GOP
     structure — `Max Bitrate only supported with CRF mode` /
     `CBR Rate control is currently not supported for RANDOM_ACCESS/
     ALL_INTRA, use VBR mode` → `Error setting encoder parameters` → the
     encoder never opens and ZERO segments are written. Every
     software-AV1 plan was unrunnable with the flag present, and only
     execution could show it (the goldens were self-consistent and green).
     Isolated across three variants: `-b:v` alone and `-b:v` + `-bufsize`
     both succeed (`BRC mode: VBR`, segments written); adding `-maxrate`
     is what fails — so the correction is exactly that one omission, and
     `-bufsize` stays. SCOPED to the software encoder: the hardware av1
     wrappers take `-maxrate` through the same generic rate-control fields
     their h264/hevc siblings already use here, and no hardware on the
     project's own machine can execute them — narrowing the deviation to
     the ONE encoder with evidence keeps the hw paths identical to their
     proven h264/hevc form for P3.4's hardware checklist to verify. Same
     real-execution-wins basis as interpretation D's own VT correction.
     Pinned by `apps/worker/test/transcode/av1-encode-args.integration.spec.ts`
     (real ffmpeg, ffprobe-verified `codec_name == av1`) and golden 40.
   - GOP flags (`-g`, `-force_key_frames`) and every surrounding segment
     are codec-agnostic and unchanged.
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
the master playlist lists the ADVERTISED rung set (§7.5 — all surviving
rungs on Tier 1+, the variant-capped subset on Tier 0); **each rung is a
separate workload governed by the §9 admission slot** — only the initially
selected rung encodes, and a client ABR switch HANDS THE SESSION'S EXISTING
SLOT to the requested rung (§9.1, LD-16); it never starts an additional
pipeline. (This paragraph originally described rungs as "lazily started"
sibling pipelines; Wave C2 made the slot-handoff semantics normative — the
lazy-start idea survives as "a rung costs nothing until the slot is handed
to it".) `isLocal` networks skip the network cap but honor device caps.

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
(§6 interp. M) — **but only when the SOFTWARE row's own probe-verified
`encode` list includes av1. On any rule-(iii) route whose software row
lacks that verified av1 encode, at ANY tier, every av1 rung is demoted by
the same §7.1(g) shared primitive, `cause=software-route-no-av1`.** That
clause is design law 4 ("verified capabilities only") applied to the
route-collapse corner, not a new law: `'hw'` eligibility is a fact about a
HARDWARE backend, and rule (iii) does not use that backend — the encoder
that actually runs is the software one, which §7.3's D4 narrowing reports
av1-capable only when `libsvtav1` really encoded a bitstream on this box.
Keeping the rungs there would hand the builder an encoder name nothing on
the machine has. The tier test is evaluated FIRST, so the tier-0 arm above
is untouched in behaviour AND in reason wording: a T0 route demotes with
`cause=tier0-software-route` even where the software row does verify av1
(there the LAW, not a missing encoder, is the reason). Likelihood is low —
it takes an ffmpeg carrying hardware AV1 but no `libsvtav1`, which every
vendored build excludes — but "unlikely" is not "impossible", and an
unverified encoder is precisely what design law 4 exists to refuse
(C1 fable-review finding 1, owner-adopted 2026-08-11; lands as
ENGINE_VERSION 0.10.1, matrix case 530).
Known conservatism, stated not hidden: a T0 box whose hw
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
  project's own Apple Silicon hardware — an honestly-exercised refusal the
  test suite can actually reach, not one that is merely asserted.

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

### 7.5 Advertised variant set (LD-6 under LD-16, Wave C2 — lands as ENGINE_VERSION 0.11.0)

The master playlist (§9.1) advertises `plan.ladder` — nothing else, and
all of it. Which rungs a client may switch to is therefore a PLAN
decision, made here in the pure engine where the matrix can prove it, not
a session-layer filter that could drift from the plan the audit row
stores.

**Step (h) — Tier-0 variant cap.** A final-assembly step, running on the
FINAL ladder — after §7.1's steps (f)/(g), after the cap filters (a)–(e),
and after any Stage-G replacement (`software-fallback:tier-capped`
dropping, av1 residual demotion) — for the same reason the open-GOP flag
lives at final assembly: the facts it needs are not settled earlier. When
`policy.tier === 0` AND the final ladder has more than
`TIER0_MAX_ADVERTISED_VARIANTS = 3` rungs, the ladder is trimmed to
exactly 3 by a deterministic keep rule:

1. keep the TOP rung (the `topRungOf` maximum — `video.targetCodec` and
   the initially-encoded rung are therefore untouched by the cap);
2. keep the LOWEST rung (the same floor the network-cap filter already
   refuses to drop — the rescue rung a collapsing connection falls to);
3. keep the rung minimizing
   `|ln(videoBitrateBps) − (ln(top) + ln(lowest))/2|` (the geometric
   middle; tie → the lower-bitrate candidate).

Array order is preserved (the ladder is emitted in policy-table order;
trimming removes elements, never reorders). The trim fires informational
reason `ladder-variant-capped` once, `detail` listing every dropped rung
(§4). Tier 1+ ladders are NEVER trimmed by this step (owner-decision V6):
LD-16 constrains Tier-0's advertised count only, and on bigger hardware
switch churn is absorbed by headroom that Tier-0 does not have. A ladder
already at ≤ 3 rungs is untouched and no reason fires — which, note, is
every T0 full-software route today (§8.3's tier cap already leaves ≤ 2
rungs) and every ≤-3-rung policy table: those plans stay byte-identical
(`engineVersion` aside).

The constant is a TIER LAW, not a `ServerPolicy` knob — deliberately: a
settings checkbox that re-widens the advertised set on Tier-0 would be
exactly the "escape hatch is a checkbox" failure §7.2 refuses for AV1.
The escape hatch is the tier, same as it is there.

**Why 3, with the N100/4GB arithmetic the owner signs (owner-decision V1;
the reasoning is decidable, each step checkable independently):**

- **Encoding cost is count-INVARIANT.** Under §9.1's delivery model
  exactly ONE rung encodes at any instant, whatever the advertised count
  — LD-16's handoff makes that structural. So the cap is NOT about
  concurrent encode load; the admission semaphore (`cap = 1` T0 default)
  already bounds that, sessions × 1 pipeline.
- **The count's real Tier-0 cost is switch churn.** Every ABR switch is a
  full pipeline handoff: kill + observed exit + spawn + input open + seek
  + encoder init + first 6 s GOP (§9.1.4) — the most expensive part of a
  run (the seek-livelock lesson: 17 uncontrolled respawns produced
  nothing). Measured shape on the reference box: QSV h264/hevc ≈ 1–2 s
  wall; the T0 software route (≤ 480p rungs only, §8.3) ≈ 2–4 s. Fine as
  a rare event; hostile as a steady state on a 6 W part.
- **Churn frequency is governed by rung SPACING, and spacing is what the
  cap buys.** An ABR controller switches when its throughput estimate
  crosses a variant-bitrate boundary. The default 6-rung table's adjacent
  ratios fall as low as 1.33× (4M→3M) — inside ordinary Wi-Fi variance
  (±30–50%), so a 6-variant master invites boundary-hovering, each hover
  a full handoff. The 3-rung keep rule (top/geometric-mid/floor)
  guarantees adjacent ratios of at least ~2× for every realistic table
  (default table, 1080p source: keeps 1080p@8M, 720p@3M, 360p@0.8M —
  ratios 2.7× and 3.75×): the estimate must HALVE or DOUBLE to cross a
  boundary, so steady-state switches become rare events (join, genuine
  congestion), not oscillation.
- **Why not 2:** dropping the middle leaves an 8M→0.8M (10×) or
  8M→1.5M (5.3×) cliff — one congestion event costs the viewer a 5–10×
  quality drop with no intermediate recovery step.
- **Why not 4+:** any 4th rung from the default table re-introduces a
  sub-2× boundary (8M/4M = 2.0× is the best case; 4M/3M = 1.33× the
  common one), and buys no capability 3 does not already have (one
  quality step down + a floor).
- **Memory and disk are count-invariant too** (single pipeline): ffmpeg's
  resident set is one pipeline's (~150–400 MB at 1080p) regardless of
  count, inside the 4 GB budget exactly as pre-C2; on-disk segments are
  retention-bounded (§9.1.8), not per-variant.

*Tier-0 lens:* the cap's entire effect on an N100 is fewer pipeline
restarts. It removes no capability — top quality, one downshift, and a
floor all survive — and costs zero CPU itself (a list trim inside
`plan()`).

**Matrix churn, stated for the regression law (§10):** existing T0
transcode cases whose surviving ladder exceeds 3 rungs WILL change
(ladder shrinks + one new informational reason; decisions never flip).
The C2 build edits each such case file in the same PR with a `why:`
comment per the regression law. T1+ cases, non-transcode cases, and
≤-3-rung cases must be byte-identical (`engineVersion` aside) — that IS
the C2 regression pin.

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
  - **Lead arithmetic (V8):
    `ahead = produced − max(requested, currentRun.startSegment)`.** A
    `requested_segment` below the current run's `start_segment` is a
    numbering artifact of a pre-restart request, not encoder lead: global
    numbering only moves forward, so after ANY restart the client's last
    requested index can sit far below the new run's start while the encoder
    has produced nothing. Raw `produced − requested` reads that as a huge
    lead and SIGSTOPs the fresh run before its first segment, with the
    resume condition (ahead ≤ 5) arithmetically unreachable — a hard
    deadlock (QA 2026-08-12, "buffers forever"). The floor closes BOTH
    triggers: the backward-seek case AND the latent pure-rung-switch case
    (a §9.1.4 handoff run spawns at `produced + 1` while requested pins at
    the old run's index — no seek anywhere). Both are design-pinned in
    `seek-rung-switch.integration.spec.ts`, not QA discoveries.
  - **Restart hygiene (V8):** a restart voids the throttle's OWN
    suspension in one statement — `suspended_by_throttle` -> false AND a
    throttle-caused `status='suspended'` -> 'active' (a fresh process is
    by definition not throttle-stopped, and leaving the status under a
    cleared flag flips the row's MEANING to "heartbeat-suspended", which
    the reconciler honors by stopping the fresh run — the A3 deadlock
    wearing a new hat). A genuine heartbeat-cause suspension (flag already
    false) is untouched and stays honored; a seek restart is unaffected
    (its status is 'seeking'). And throttle reconciliation runs EVERY
    tick; an absorbed seek must not `continue` past it.
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
  - **The seek control channel is the contract call (V8):**
    `POST /playback/sessions/{id}/seek { targetMs, rungIndex? }` → 202
    carrying the CLAMPED target. A thin, contract-visible alias of the
    segment-GET side effect — same `seek_target_ms` column, same
    absorption, and when `rungIndex` rides along, the same §9.1.7
    single-statement write (`requestSeekWithRungSwitch`). Standard bearer
    auth (NOT the `?token` media-GET family — §9.1.9's zero-new-auth-
    surface stance holds: one new route on an existing guard, no new token
    surface). Direct-play sessions answer 409
    (`urn:loombre:problem:not-a-transcode-session`). WHY a first-class
    call: hls.js only requests URIs the playlist lists, and the UA clamps
    `currentTime` writes to `video.seekable`, so an out-of-window target
    could never reach the segment-GET trigger at all — the restart
    machinery below existed but was unreachable (QA 2026-08-12), which
    surfaced as "rewind skips forward".
  - **"Outside" decided per segment GET is DEMOTED to defense** (native
    clients, mid-prune races), unchanged mechanics (apps/server's
    `hls-file.controller.ts`): the requested index is more than 3 ahead of
    `produced_segment`, OR the file is simply not on disk (a run that has
    not reached that number yet, or a retention-pruned one). Either way the
    response is 503 + `Retry-After`, never 404 (a 404 would fatal hls.js's
    fragment immediately; 503 keeps it polling until its playlist refresh
    shows the new run). The 503 detail must NOT promise the requested URI
    will appear — forward-only numbering guarantees the retried filename
    never exists again (the new run writes `run{N+1}/` at `produced + 1`
    and higher); the honest detail is that a restart was requested and the
    playlist should be re-read. The pre-V8 "coming soon after a restart"
    wording documented an unkeepable contract.
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

### 9.1 Multi-variant delivery — ABR (LD-6, governed by LD-16; spec'd 2026-08-11, Wave C2)

#### 9.1.0 The law, verbatim, and the shape it forces

LD-16 (owner-adjudicated 2026-08-10, normative here): **"every quality
rung is a separate workload governed by the existing admission capacity
limit; a quality change hands the existing slot from one rung to another
— it never starts an additional unrestricted transcode."**

The design below makes the law STRUCTURAL rather than policed: one
session = one admission slot = at most one live encoding pipeline, ever.
A rung switch is a restart of that one pipeline with different rung args
— the same kill→observed-exit→respawn machinery a seek already uses — so
a second concurrent encode per slot is not forbidden, it is inexpressible.
A hypothetical future concurrent-rung mode (encoding two rungs of one
session at once) would require one admission slot per concurrently-
encoding rung to stay inside the law; it is OUT of v1 scope and recorded
here only as the law's forward constraint.

*Tier-0 lens:* on the N100 default (`maxSimultaneousTranscodes = 1`) the
machine-wide encode ceiling after C2 is IDENTICAL to before C2: one
pipeline. ABR adds switch events, not concurrency.

#### 9.1.1 Delivery model: one pipeline, one playlist, variant identity in the URL

- The worker keeps producing exactly ONE served playlist per session (the
  existing union of runs, global segment counter, `EXT-X-DISCONTINUITY` +
  fresh `EXT-X-MAP` between runs — §9 unchanged).
- The server adds a MASTER playlist enumerating the advertised variants
  (`plan.ladder`, §7.5), one `EXT-X-STREAM-INF` per rung, whose variant
  URIs are `v{K}/media.m3u8` with `K` = the rung's index in `plan.ladder`.
- **Every variant URL serves the same playlist bytes**: `v{K}/media.m3u8`
  returns the one served playlist (with §9's media-sequence treatment),
  and its relative segment URIs resolve to `v{K}/runN/sNNNNNN.m4s`, which
  the segment route serves from the same on-disk `runN/` files. Variant
  identity lives ONLY in the URL path.
- **The URL path IS the switch signal.** A playlist or segment GET whose
  `v{K}` names a rung other than the session's active one records a
  rung-switch request (`requestRungSwitch`, §9.1.3) as a side effect and
  is otherwise served normally. The worker consumes the request at its
  next poll tick and hands the slot over (§9.1.4). Segments the old rung
  already produced keep serving from disk — they are presentation
  history; only the live edge waits (503 + `Retry-After: 1`, the existing
  segment-not-ready shape) until the new rung produces.
- RFC 8216's cross-variant obligations are met trivially: media sequence
  numbers, discontinuity structure and timelines "match across variants"
  because the variants ARE one playlist.
- Because rung switches restart the pipeline at a segment boundary and
  §6's `-force_key_frames` opens every segment of an encoded run with an
  IDR, `EXT-X-INDEPENDENT-SEGMENTS` is emitted in the master.

Why server-driven single-pipeline rather than N true variant playlists:
N playlists require N pipelines (or on-demand sibling starts — an
unrestricted second transcode, the exact thing LD-16 forbids), N× disk,
and cross-variant segment-boundary bookkeeping. This model reuses every
verified mechanism Wave A landed (run map, seek derivation, media
sequence, progress mapping) with zero semantic changes to any of them.
The trade-off it buys that with is switch latency bounded by the
produced-ahead window (§9.1.10).

**Master playlist rendering (server-side, deterministic, pure).**
Rendered from the stored plan + probed MediaInfo alone — no filesystem or
worker involvement, available at 200 the moment the session row exists
(never 503; Tier-0: a string template, no CPU-heavy work on a request
path). One `EXT-X-STREAM-INF` per `plan.ladder[K]`, in array order:
- `BANDWIDTH = ceil(1.1 × (videoBitrateBps + audioBitrateBps))` (peak
  headroom over the declared targets), `AVERAGE-BANDWIDTH =
  videoBitrateBps + audioBitrateBps`;
- `RESOLUTION = W×heightPx` with `W` = the arg builder's own scale-width
  arithmetic for that rung (source aspect, even-rounded) — the master
  must state what the encoder will actually emit, so the two share one
  helper;
- `FRAME-RATE` = the selected video stream's `frameRate`;
- `CODECS` = a fixed deterministic table keyed by (rung codec, bitDepth)
  producing strings consistent with the §6 encode block's own
  profile/level flags (h264 → `avc1.*`, hevc → `hvc1.*`, av1 → `av01.*`;
  av1 rungs emit no `-level` (§6 M), so the av01 string's level field
  comes from a fixed height-keyed sub-table). Exact strings are pinned by
  server-side goldens at build and verified ONCE against ffprobe of real
  encoder output (fence — a wrong CODECS string makes hls.js reject the
  variant, so the table must be execution-verified, not assumed).
Ladder-empty HLS sessions (direct-stream copy, audio-only transcode)
render a single-variant master: `v0/media.m3u8`, `BANDWIDTH` from
`media.overallBitrateBps` (copy) or the audio target bitrate (audio-only)
with the same 1.1 headroom, `CODECS` from the probed source stream facts,
no `RESOLUTION` when no video. The subtitle hls-vtt side-track stays
OUTSIDE the master (the existing `<track>` wiring) — declaring it as
`EXT-X-MEDIA` is an explicit non-goal of v1.

#### 9.1.2 Contract surface (complete enumeration; empirical oasdiff preview)

1. **New path** `GET /playback/sessions/{id}/hls/master.m3u8`
   (operationId `getPlaybackHlsMasterPlaylist`): 200
   `application/vnd.apple.mpegurl` (Cache-Control private, no-store), 401,
   404 (unknown/foreign/terminal session, and direct-play sessions — they
   have no HLS surface), default problem; `?token=` query fallback
   exactly like the sibling media routes. Never 503.
2. `GET /playback/sessions/{id}/hls/{file}`: the `file` pattern gains the
   optional `v{K}/` prefix — `v{K}/media.m3u8`, `v{K}/runN/sNNNNNN.m4s`,
   `v{K}/runN/init.mp4`; bare legacy shapes (`media.m3u8`, `runN/...`)
   remain valid and are treated as the ACTIVE rung (no switch signal).
   DESCRIPTION-only contract change; no structural change, no oasdiff
   finding.
3. `PlaybackSession.manifestUrl`: VALUE semantics change (owner-decision
   V5) — points at `.../hls/master.m3u8` for every HLS session
   (single-variant master included; uniform client path); stays `null`
   for direct-play. Schema untouched; description updated. No new session
   properties: the client needs nothing else (the plan already carries
   the ladder), and the admin now-playing surface can read the plan.
4. **New `PlanReasonCode` fixed informational member:**
   `ladder-variant-capped` (§4, §7.5 — owner-decision V2;
   `contract-reason-codes.spec.ts` enforces engine/contract agreement in
   both directions, the D1 precedent).
5. **No new problem codes** (`hls-not-ready` / `hls-segment-not-ready`
   already say exactly the right things), no `PlaybackSessionStatus`
   change (§9.1.4 — a pure switch never enters `seeking`), no
   `PlaybackPlan` schema change (the ladder was always there), no event
   schema changes, no settings-registry changes (§7.5's constant is a
   tier law, not a knob).

**Empirical oasdiff preview (run 2026-08-11 against these exact edits,
LD-7 precedent): 0 errors, 3 warnings, 1 info — gate-passing.** The
warnings are the same `response-property-enum-value-added` trio every
closed-enum reason addition produces (`POST /playback/plan` 200,
`POST /playback/sessions` 201, `GET /playback/sessions/{id}` 200); the
info is `endpoint-added` for master.m3u8. The `file`-pattern and
`manifestUrl` description updates produce no findings. SDK regenerated
atomically with the contract edit; conformance unimplemented-allowance
stays zero (the new operation lands WITH its controller).

#### 9.1.3 Session & run bookkeeping (DB; the EXTENT-trap rule)

Migration **0044 reserved for C2** (renumber by the next-free rule if a
parallel lane claims it first), additive-only, real columns per invariant
3 — one migration, three pieces:
- `playback_sessions.active_rung_index INTEGER NULL` — index into the
  stored plan's ladder of the rung the pipeline is currently encoding.
  Written by the worker at every spawn (run 0 writes the initial rung =
  `topRungOf(plan.ladder)`'s index, the plan's own `ffmpegArgs` rung —
  status quo). NULL for direct-play, ladder-empty, and pre-C2 rows.
- `playback_sessions.pending_rung_index INTEGER NULL` — the requested
  rung, written by the server (`requestRungSwitch`, own-session-scoped
  like `requestSeek`, validated `0 ≤ K < ladder.length` at the
  controller), consumed by the worker under the SAME compare-and-clear
  discipline as `seek_target_ms` (guarded UPDATE on the exact value read;
  a different value written meanwhile survives to the next tick).
  `requestRungSwitch` is absorb-on-match at the WRITE side too: a request
  naming the already-active rung is not recorded (nothing to do), which
  is the switch analogue of seek absorption and kills request storms at
  the door.
- `transcode_runs.ladder_rung_index INTEGER NULL` — which rung this run
  encoded (index into the stored plan's ladder at spawn time). NULL for
  pre-C2 rows and ladder-empty sessions. `recordTranscodeRun` gains the
  field; everything else about the row is unchanged.

**Run indices stay GLOBAL per session** — a rung switch increments the
same `run_index` counter a seek does, `start_segment` stays the only
monotonic key, and `getTranscodeRunForSegment` keeps its greatest-
`start_segment`-≤-N semantics unchanged. That lookup remains CORRECT
under ABR precisely because this model never runs rungs in parallel:
segment ownership is still total and non-overlapping.

**The EXTENT rule (normative closure of the A2 finding).** A
`transcode_runs` row records where a run STARTS, never where it ends.
Any consumer needing a run's EXTENT MUST use one of exactly two derivations:
(a) the served playlist's `runN/` URI prefix — the on-disk truth,
    what `deriveSegmentStartMs`/`presentationToSourceMs` already do; or
(b) the NEXT run's `start_segment − 1` as the closed upper bound, from
    the session's full ordered run set — the DB truth, valid because
    `{START_SEG} = producedSegment + 1` makes consecutive runs' segment
    ranges partition the counter with no gaps or overlaps (the current
    run is unbounded above).
Deriving extent from one row alone (e.g. `index >= start_segment`) is the
recorded trap and is FORBIDDEN — it sweeps in every later run, rung
switches included. The C2 build adds this sentence as a doc comment at
`getTranscodeRunForSegment` itself so the next consumer meets the rule at
the call site, not in this file.

#### 9.1.4 Slot handoff (LD-16 mechanics)

**The slot is held by the SESSION at every instant.** Admission counts
non-terminal session rows (`countActiveTranscodeSessions`), so the slot
can only free when the session goes terminal — never during a handoff. A
rung switch touches no admission state whatsoever: no census change, no
429 path, nothing for the gate to serialize.

**Terminate-then-start, zero overlap — chosen over bounded overlap.** The
worker's handoff sequence (one poll tick, composing with the existing
seek block):

1. Tick reads `pending_rung_index = B ≠ active_rung_index` (compare-and-
   clear discipline; a concurrent different write survives to next tick).
2. `await currentRun.handle.terminate()` — SIGCONT-before-SIGTERM(-then-
   SIGKILL) exactly as for a seek, resolving only at OBSERVED exit (the
   same observed-exit discipline whose reaper-side form Wave A pinned as
   kill→re-inspect→free-slot; the build asserts the runner side too).
3. Old process dead (observed) → compute the new run's source origin
   `originB = currentRun.sourceOriginMs + currentRun.producedMs` (exact —
   ffmpeg's own per-run playlist is append-only, so `producedMs` is the
   run's true produced extent even after retention pruning of the SERVED
   playlist) and rebuild args for rung `plan.ladder[B]`
   (`rebuild-args.ts` gains the rung parameter; the builder's existing
   per-rung seam). The encoder name comes from the routed backend +
   RUNG's codec — a mixed-codec ladder (av1 top / hevc mid, §7.1) makes
   this load-bearing, and a golden pins it.
4. `spawnRun(runIndex+1, startSeg = producedSegment+1, argsB,
   seekTargetMs = originB)` — records the `transcode_runs` row (with
   `ladder_rung_index = B`), overwrites `worker_pid`/
   `worker_started_at_ms` (every spawn already does), registers in the
   live-run registry, updates `active_rung_index = B`.
5. Next ticks fold the new run's playlist exactly like any run:
   discontinuity + fresh `EXT-X-MAP`, produced counter advances.

Rejected alternative, with reason: BOUNDED OVERLAP (start the new rung,
kill the old once the new produces) would double the encode load for the
overlap window — on Tier-0 that is 2× of a box sized for 1×, i.e. the
precise "additional unrestricted transcode" LD-16 forbids, merely
time-limited. Zero-overlap costs a few seconds of live-edge 503 that the
client's retry policy (8 × 1 s linear, tuned for exactly this server
behavior) already absorbs.

**Process-census invariant (build must pin it):** at every instant a
session has ≤ 1 live ffmpeg. The integration test samples real OS process
state across a switch (the lifecycle-test pattern) and asserts the count
never reaches 2.

**Status/state machine:** a PURE rung switch never changes session
status — the union playlist stays fully servable (`active`/`suspended`
semantics untouched), heartbeats flow, and only live-edge segment GETs
503 during the handoff. (Contrast a seek, which flows through `seeking`
because its restart INVALIDATES the forward timeline; a switch continues
it.) A COMBINED seek+switch follows the seek's status path (§9.1.7).

**Failure table (who owns what when it goes wrong):**

| Failure point | Old proc | New proc | Slot | Client sees |
|---|---|---|---|---|
| Rebuild/spawn throws after old exit (step 3–4) | dead | never started | session → `failed` (markSessionFailed, the seek-path precedent) → terminal → slot freed | 503s, then manifest/session 404 → the existing client-synthesized-reason fatal path → UnavailableScreen |
| Worker crashes between kill and spawn | dead | never started | session non-terminal, slot HELD (correct: nothing encodes, nothing violates the cap) | 503-retries; next worker boot's reaper finds `worker_pid` dead/unverifiable → session reclaimed → failed; or the 15-min heartbeat sweeper ends it first |
| New run spawns then instantly dies (bad args, ENOSPC) | dead | exited ≠ 0 | the existing unexpected-exit branch → `failed` → slot freed | as row 1 |
| Old process refuses to die within the kill window | alive (SIGKILL pending) | NOT started — spawn is sequenced strictly after observed exit, so the census invariant holds by construction | session holds slot | 503-retries until exit-then-spawn completes |

**Boot reaper composition:** unchanged and already correct — `worker_pid`
always names the live run because every spawn overwrites it (switch
spawns included); the reaper's pid+cmdline-vs-staging_dir verification,
process-group kill, and slot-cannot-free-until-confirmed-dead ordering
apply to a switch-spawned run identically. `transcode_runs.
ladder_rung_index` is bookkeeping the reaper never reads.

**Throttle/pacing composition:** `reconcileThrottle` needs no changes —
its inputs (`produced_segment`, `requested_segment`) are global counters
that remain monotonic across a switch. The new run starts physically
un-suspended (fresh process, `processStopped = false`), win32 `-readrate`
pacing is injected per spawn exactly as today, and `suspended_by_throttle`
converges within one tick. Physical suspend state deliberately does NOT
carry across a handoff: if the client is still >10 ahead the reconciler
re-suspends immediately; encoding at most one extra tick's worth is
cheaper than plumbing suspend state into spawn.

#### 9.1.5 Playlist-type & retention model (closes the RFC 8216 §4.3.3.5 contradiction — A2 finding a)

Current behavior, stated plainly: the served playlist declares
`EXT-X-PLAYLIST-TYPE:EVENT` (append-only per RFC 8216 §4.3.3.5) while
retention prunes its head — a genuine contradiction — and never emits
`EXT-X-ENDLIST` at all (a finished encode plays out and then polls
forever). The multi-variant model REPLACES this with a coherent,
RFC-clean model (owner-decision V3), identical under every variant URL by
construction (§9.1.1 — one playlist):

1. **No `EXT-X-PLAYLIST-TYPE` tag, ever** (neither EVENT nor VOD). A
   type-less playlist is the RFC's sliding-window live shape: clients may
   not assume append-only, head removal is legal when signalled.
2. **`EXT-X-MEDIA-SEQUENCE`** — landed (Wave A): first surviving
   segment's absolute index, emitted when > 0.
3. **`EXT-X-DISCONTINUITY-SEQUENCE` (new, mandatory once a whole run is
   pruned).** RFC 8216 §4.3.3.3: removing a discontinuity from the head
   without incrementing the discontinuity sequence desynchronizes the
   client's discontinuity counter (hls.js's `cc` tracking). Because
   retention prunes from the front and runs are sequential, wholly-pruned
   runs form a prefix — so the tag's value IS the first listed segment's
   own `runN` index, computable in the same place `withMediaSequence`
   already computes the media sequence, emitted when > 0. An unpruned
   playlist stays byte-identical (both tags absent).
4. **Terminal `EXT-X-ENDLIST` + prune-freeze.** When the CURRENT run's
   own ffmpeg playlist carries `#EXT-X-ENDLIST` (the parser already
   records `hasEndlist`; the renderer starts consuming it), the served
   playlist appends `ENDLIST` — and from the first serve of an
   ENDLIST-bearing playlist, retention pruning for that session CEASES
   (RFC: an ended playlist must not change). Disk stays bounded: at
   ENDLIST no new segments are produced either, so the residual is at
   most one retention window (§9.1.8), reclaimed at session teardown as
   always. This finally gives transcode playback a real `ended` signal
   (duration resolves, the media element fires `ended`).
5. **A post-ENDLIST seek/switch un-ends the playlist** (new run → tag
   gone, discontinuity, pruning resumes). RFC-wise that is "a new
   playlist"; client-wise hls.js has stopped polling after ENDLIST — so
   (V8, amendment A1) the CLIENT re-arms: a post-ENDLIST hard seek is the
   normal §9.1.9 hard-seek procedure with playlist loading explicitly
   restarted (`startLoad()` or equivalent) as part of ENTERING the
   relocating state. Without that re-arm the landing watch can never fire
   — the POST lands, the playlist un-ends, and nobody re-reads it: the
   infinite spinner rebuilt on the exact path this rule exists to fix.
   Design-pinned by a Wave 3 test. The old fatal-network ride
   (pruned-segment GET → 503 ×8 → fatal → `startLoad()`) is demoted to
   generic network recovery; it is no longer a seek mechanism.
6. **The live-edge-jump hazard moves client-side and is closed there.**
   Dropping EVENT makes the stream look live; hls.js's default
   `startPosition: -1` would then start at the live edge — which for
   this throttled server is ≤ 10 segments past the resume point, i.e. the
   wrong place. The client config therefore PINS `startPosition` to the
   intended start (resume point or 0) — §9.1.9 — and the existing
   loadedmetadata seek stays as belt-and-braces. No
   `liveMaxLatencyDuration*` is ever set (defaults = no forced live-edge
   chasing), so nothing yanks a paused/seeking viewer forward.
7. **`EXT-X-PROGRAM-DATE-TIME` on EVERY segment (V8) — the source clock,
   in-band.** Above each segment line the worker's renderer emits
   `#EXT-X-PROGRAM-DATE-TIME:<ISO8601 of (Unix epoch + the segment's
   SOURCE start in ms)>` — source time 0 IS `1970-01-01T00:00:00.000Z`
   (ruled: the 1970 wall-clock cosmetic is not a supported audience;
   session URLs are token-gated). Value =
   `run.sourceOriginMs + Σ(that run's own prior #EXTINF)`, computed from
   the runner's in-memory run registry (`RunState` carries
   `sourceOriginMs`) — no serve-time DB read. Emission is PER SEGMENT,
   not per run: head-pruning then needs no "first listed segment of the
   run" bookkeeping, at ≈ 45 bytes × ~20 listed segments. Within a run
   the mapping is exact (§9.1.6's rate argument); the one bound is input
   `-ss` keyframe snap — a seek run's first frames may predate its
   recorded origin by ≤ one GOP, one-time per run, non-compounding, the
   same bound the §9 progress mapping already accepts. Clients read it as
   `frag.programDateTime` (hls.js — the value IS source ms) or
   `video.getStartDate()` (Safari native).

**Scope guard — this model governs the SERVED playlist only.** ffmpeg's
own per-run playlist KEEPS §6's `-hls_playlist_type event`: within one
run it genuinely IS append-only (ffmpeg never prunes it, and the event
type forces an unbounded list), and that completeness is exactly what
makes `producedMs` — and therefore §9.1.4's handoff-origin arithmetic —
exact. A build lane must not "fix" the §6 flag by analogy with this
section; the contradiction A2 found was in the served wrapper, never in
the run playlist.

*Tier-0 lens:* every rule above is string assembly at serve time; the
prune-freeze strictly REDUCES steady-state I/O after stream end.

#### 9.1.6 Timeline model (closes the deferred `-copyts` decision — A2 finding c)

**Decision (owner-decision V4): `-copyts` stays OUT, permanently for v1.
Every run — initial, seek, rung-switch — is spawned `-ss` with a
zero-based output timeline, and `transcode_runs` remains the ONLY bridge
between presentation and source time.** Rationale, so it is not
re-litigated ad hoc: (i) rung switches need `EXT-X-DISCONTINUITY` anyway
(codec/resolution change ⇒ new init segment), so `-copyts` could not
remove discontinuities even where its timestamps cooperated; (ii)
backward seeks make source timestamps non-monotonic across runs — a
single continuous timestamped timeline is unrepresentable in one playlist
regardless; (iii) every consumer built and verified in Wave A
(`deriveSegmentStartMs`, `presentationToSourceMs`, seek de-dup, run
recording) assumes per-run zero-based timelines; `-copyts` would fork the
timeline semantics per restart cause and re-verify all of it for zero
functional gain.

**Rung switches preserve the presentation timeline EXACTLY.** The
handoff origin is `originB = old.sourceOriginMs + old.producedMs`
(§9.1.4 step 3) — the precise source instant after the old run's last
produced segment — so presentation time remains continuous across the
switch discontinuity and source anchoring stays exact: a switch-spawned
run is indistinguishable from any other run to every §9 derivation. A
seek-spawned run's origin remains the consumed (clamped) seek target,
exactly as before. Composition of run origins across an arbitrary
seek/switch history therefore needs no new rules: each run's row is
self-contained, ownership follows the segment counter, and the §9
progress mapping (`presentationToSourceMs`) is UNCHANGED and correct for
multi-variant sessions by construction — its within-run 1:1
rate-equivalence argument is rung-independent (re-encoding at a different
bitrate/height never changes the time rate). The build pins this with a
progress-across-switch test rather than new code.

**PDT does not reopen this decision (V8).** §9.1.5 rule 7's
`EXT-X-PROGRAM-DATE-TIME` is playlist METADATA rendered by the worker
from the run map — media timestamps stay per-run zero-based, `-copyts`
stays out, and zero ffmpeg arguments change. It is the same
`transcode_runs` bridge this section already names as the sole timeline
bridge, published in-band so clients can consume it directly. A future
lane must not read PDT as re-litigating V4.

#### 9.1.7 Seek ⨯ switch composition

- **One restart serves both.** The worker's restart block reads BOTH
  `seek_target_ms` and `pending_rung_index` in the same tick and spawns
  ONE run: rung = pending rung if set else active rung; origin = seek
  target if set else the live-edge continuation origin (§9.1.4). Both
  columns are compare-and-cleared against the exact values read. A seek
  arriving during an in-progress handoff simply lands on the next tick
  (the handoff is within-tick); a switch arriving during a pending seek
  folds into the seek's restart. Never two restarts.
- **The endpoint carries the coincident pair (V8).** `POST …/seek`
  accepts optional `rungIndex` and records
  `{seek_target_ms, pending_rung_index}` via the same single statement
  the URL path-signal uses (`requestSeekWithRungSwitch`) — one write, one
  restart, exactly as above. The client sends `rungIndex` when its
  quality selector holds a pin to a non-active rung at hard-seek time.
- **Absorption narrows under a pending switch.** The §9 seek-absorption
  rule (target inside the live run's `[origin, origin+produced]` window)
  gains one conjunct: absorb ONLY when `pending_rung_index` is unset or
  names the live run's own rung — a seek into already-produced OLD-rung
  output must still restart when a switch is pending, because the client
  asked for different bytes, not the same ones. Switch-request absorption
  (§9.1.3) is handled at the write side.
- **Ordering guarantee:** `requestSeek` and `requestRungSwitch` are
  independent columns; the worker's single-restart rule makes their
  interleaving commutative — whichever lands first, the spawned run is
  (requested rung, requested origin).
- **The named build scenario (C3 triple-seek extension —
  `seek-rung-switch.integration.spec.ts`, real ffmpeg):**
  `forward seek → backward seek → rung switch → forward seek` producing
  runs 0–4 where run 2's origin is EARLIER than run 1's (the existing
  backward pin), run 3 is a switch run whose origin equals run 2's
  origin + produced extent EXACTLY, and run 4 seeks within the new rung.
  Asserts: per-run derivation exact at a probe segment inside every run;
  `presentationToSourceMs` correct for a position inside the switch run;
  `getTranscodeRunForSegment` resolves the switch run (not its
  predecessor) at the boundary; extent-by-prefix and extent-by-next-start
  agree (§9.1.3); ≤ 1 live process at every sample point; exactly one
  restart for a coincident seek+switch tick.

#### 9.1.8 Retention & disk (Tier-0 arithmetic)

Retention is UNCHANGED in mechanism: one global 120 s window over the
union playlist, whatever rungs produced the segments in it; old-rung
segments age out under the same rule as same-rung ones; `runDirsToDelete`
retires wholly-pruned run directories (init segments included).
Steady-state disk is therefore count-invariant and rung-independent:

    disk ≈ (active-rung bitrate / 8) × (120 s retention + 60 s
           max produced-ahead) + per-run init/playlist KBs

- default T0 top rung 1080p@8M: ≈ 1 MB/s × 180 s ≈ **180 MB**
- worst policy rung 2160p@16M(hevc): ≈ 2 MB/s × 180 s ≈ **360 MB**
- the advertised-variant count contributes ZERO bytes (§9.1.1 — no
  sibling pipelines, no per-variant segment sets)

A switch transiently holds both the old rung's window remnant and the new
rung's fresh segments, still inside the same global 120 s window — no
additive term. The ENDLIST prune-freeze (§9.1.5) caps the residual at
one final window until teardown deletes the session dir. All figures sit
comfortably inside the NVMe staging budget an N100/4GB target already
carries for one session, and the T0 admission cap (1) makes them
machine totals, not per-session multipliers.

#### 9.1.9 Client (zero new auth surface)

- **hls.js path:** `manifestUrl` → master.m3u8; hls.js runs its own ABR
  over the advertised variants (auto mode is the default and the
  mechanism — level switches surface to the server as `v{K}` requests,
  §9.1.1). Config additions to `buildHlsJsConfig`, both testable pure:
  `startPosition` pinned to the resume point (§9.1.5 rule 6) and
  `startLevel` pinned to the variant matching `topRungOf(plan.ladder)` —
  the rung the server-side pipeline already starts encoding, so a clean
  start performs ZERO handoffs (hls.js's default first-load bandwidth
  guess would otherwise pick a low rung and immediately switch). Top
  surviving is network-safe by construction: Stage F already dropped
  every rung above `network.maxBitrateBps`.
- **Manual quality selection** is a client-side affordance over the same
  mechanism: a player-UI selector listing `hls.levels` and setting
  `hls.nextLevel` (pin) or `-1` (auto). No server surface — a manual pin
  is just a `v{K}` request stream like any other. Ships with C2's web
  work; the selector is the only new player UI.
- **Token/retry policies: UNCHANGED, verbatim.** Master, variant
  playlists and `v{K}/`-prefixed segments all ride the existing
  `xhrSetup` per-request token rewrite (hls.js) — same-origin
  sub-requests of the same route family; the `?token=` query fallback
  works identically on the new master route; the 8×1 s linear retry
  tuning already matches the 503/`Retry-After: 1` the handoff emits (it
  was built for the seek restart, and a handoff is one).
- **Safari native HLS:** `video.src` = master URL with `?token=`. The
  native path's empirically-verified token propagation must be
  RE-VERIFIED at build across the extra indirection hop
  (master → variant playlist → segments); if propagation does not cross
  the hop, the server renders variant URIs with the requesting token
  appended (the master is generated per-request, and the native path's
  existing paused-boundary src refresh re-reads it with a rotated token)
  — a rendering detail, not a new auth mechanism. Recorded as a
  build-phase verification item, not assumed.
- **Failure composition: UNCHANGED.** Handoff failures surface as
  session `failed` → the client's existing any-thrown-error fatal path →
  UnavailableScreen (Wave A's A4 fix); no new client error states exist
  because no new server error shapes exist (§9.1.2 item 5).
- **Heartbeat: UNTOUCHED in both directions.** A switch never suspends
  the session or resets staleness (status never changes, §9.1.4); a
  switching client keeps playing buffered content and keeps
  heartbeating; the handoff window (seconds) is two orders of magnitude
  inside the 90 s suspend cutoff. Progress PUTs keep flowing through the
  §9 server-side mapping, which is switch-correct with zero changes
  (§9.1.6). (V8 refines the reported VALUE for PDT-capable clients — see
  the seek-algorithm block below; the server-side mapping remains for
  every reporter without the PDT model.)
- **Seek algorithm (V8).** The client holds the two-timeline model in a
  pure module (`apps/web/src/lib/source-time.ts`) built from the CURRENT
  LEVEL DETAILS — every LISTED fragment with its §9.1.5 rule 7 PDT. The
  soft/hard boundary is the LISTED playlist window, never buffer state
  (amendment A2): an in-window-but-unbuffered target is a SOFT seek —
  hls.js fetches listed fragments locally, and classifying it hard would
  burn a Tier-0 ffmpeg restart for a position already on disk.
  Design-pinned by a listed-but-unbuffered unit case.
  - SOFT (target covered by a listed fragment):
    `currentTime = frag.start + (targetMs − frag.programDateTime)/1000`.
    Local; no server round-trip; both directions within the window.
  - HARD (outside the listed window): `POST …/seek {targetMs, rungIndex?}`
    → enter a `relocating` state (scrubber pins at the target, displayed
    position frozen there). IF the session has seen ENDLIST, restart
    playlist loading (`startLoad()` or equivalent) as part of ENTERING
    relocating (amendment A1 — hls.js stops polling after ENDLIST;
    without the re-arm the landing watch below can never fire). Watch
    `LEVEL_UPDATED` for fragments whose `runN/` URI prefix EXCEEDS the
    highest run index yet seen AND whose PDT falls within
    `[clampedTarget − one GOP, clampedTarget + ε]` — both conditions
    required (the prefix alone could be a §9.1.4 handoff run; the PDT
    alone could false-positive on in-window content). Land at that
    fragment's `start`. A re-seek before landing re-arms the watch with
    the newest clamped target; earlier seek runs are dead runs the client
    never lands on (server-side absorption already de-duplicates).
  - DISCOVERY NUDGE (live-QA fix, 2026-08-20): while `relocating`, the
    client forces a playlist re-read once per second
    (`HARD_SEEK_REFRESH_NUDGE_MS = 1_000`,
    `apps/web/src/lib/relocation-nudge.ts`) via hls.js's own
    stopLoad()/startLoad(-1) reload lever — the pair its fatal-network
    recovery uses. Rationale: the server side of a hard seek is fast (the
    worker's 250 ms control loop + ~0.2 s to a video-copy run's first
    segment puts the restarted run in the served playlist well under a
    second after the 202), but hls.js re-reads a live playlist only on its
    own targetduration cadence — up to ~6 s of pure discovery latency,
    which live QA measured as the bulk of the observed seek-to-play time.
    The nudge never fires synchronously (the run cannot be listed at 202
    time), goes quiet the moment the landing clears `relocating`, and
    aborting an in-flight fragment load mid-relocation costs nothing (the
    pre-seek position's buffer is already abandoned). Native-HLS sessions
    keep their 500 ms seekable-end poll instead (the UA owns playlist
    refresh there — the Q4 follow-up's territory).
  - Timeout: `HARD_SEEK_LANDING_TIMEOUT_MS = 20_000` — a NAMED CONSTANT,
    not runtime config (ruled). Sizing rationale, kept beside the
    constant: the observed 4–6 s cold restart is the dev box, NOT the
    sizing case; the sizing case is an N100-class host transcoding 4K
    input, which gets the headroom. On expiry: leave `relocating` and
    surface the existing typed player-error path with a retry affordance.
    Never an indefinite spinner.
- **Displayed position is PDT-derived source time (V8):** current
  fragment's PDT + intra-fragment offset, every timeupdate. Sessions
  without PDT (direct-play; a stale server) fall back to raw
  `currentTime` — exactly pre-V8 behavior, which keeps the client correct
  against an unupgraded server. Heartbeat `positionMs` reports the same
  source-derived value whenever the mapping exists.
- **Scrubber commits ONE seek on pointerup (V8);** dragging is preview
  only — the pre-V8 per-pointermove commit issued dozens of seeks and
  progress PUTs per drag. The `buffering` flag clears on
  `seeked`/`canplay` as well as `playing` (a paused element never fires
  `playing`; pre-V8 this latched the spinner forever on any
  seek-while-paused). The last seek target updates the re-attach
  `startPosition` pin, so recovery restores the user's intent, not the
  session's original resume point.
- **Native-HLS seeks (V8 v1 scope, ruled):** soft seeks map through
  `video.getStartDate()`; hard seeks call the endpoint and land COARSELY
  at the seekable end once it moves (no fragment-level watch on this
  path). The precise-landing follow-up is filed against the loombre-apple
  first-playback milestone — the iOS app rides this path; it is not
  optional polish.

#### 9.1.10 Known limitations (stated, bounded, accepted — owner-decision V7)

1. **Downswitch latency = distance to live edge.** The new rung starts at
   `producedSegment + 1`; segments the old rung already produced ahead of
   the playhead (throttle-capped at ≤ 10 segments / 60 s) still serve at
   the OLD quality, and a bandwidth-collapsed client must still fetch
   them. Bound: ≤ 10 segments, usually far fewer (the throttle holds the
   encoder near the playhead). The alternative — restarting AT the
   playhead and re-numbering — would break the global-counter invariant
   (at most one run owns a segment index) that every Wave A consumer
   relies on. A future replace-tail mode is possible but is a spec change
   with its own review, not a build-time judgment call.
2. **Post-ENDLIST hard seek needs the client re-arm** (§9.1.5 rule 5 as
   amended by V8/A1): the endpoint records the seek, but hls.js has
   stopped polling — the client restarts playlist loading on entering
   `relocating`, so the un-ended playlist is re-read immediately. The
   pre-V8 fatal-recovery ride (≤ ~8 s of 503s before `startLoad()`) is
   demoted to generic network recovery. Pinned by a Wave 3 test.
3. **Advertised ≠ instantly available.** A variant is a right to REQUEST
   the slot, not a parallel stream; two clients cannot watch two rungs of
   one session (they are one session — one slot, one pipeline; a second
   viewer is a second session and meets the admission gate). This is
   LD-16's intent, stated as a property rather than apologized for.
4. **A restart can permanently skip segment indices (V8).** The next
   run's start is
   `max((producedSegment ?? −1) + 1, currentRun.startSegment + 1)`,
   closing the duplicate-start collision (a seek consumed before run 0
   flushed anything used to spawn run 1 also at index 0 — two
   `transcode_runs` rows claiming one index makes
   `getTranscodeRunForSegment`'s `ORDER BY start_segment DESC`
   nondeterministic and emits duplicate media-sequence numbers across a
   discontinuity, which hls.js discards). An index skipped by the floor
   is never produced by any run; `EXT-X-MEDIA-SEQUENCE` (rule 2) already
   makes a playlist starting above 0 well-formed. At-most-one-owner
   becomes structural.
5. **Native-HLS hard-seek landing is coarse in v1 (V8, ruled):**
   seekable-end landing, no fragment-level watch. Precise landing is
   filed against the loombre-apple first-playback milestone.

#### 9.1.11 Owner decisions requested at the C2 stop (each reversible by a text edit here)

- **V1 — Tier-0 advertised variant count = 3** (top / geometric-mid /
  floor, §7.5 arithmetic — THE number this stop signs; recommended: 3).
- **V2** — informational reason `ladder-variant-capped`, single-firing
  with dropped-rung detail (recommended: YES; silent trimming leaves
  "where did my rungs go?" unanswerable — the av1-rung-demoted argument).
- **V3** — playlist model: drop `EXT-X-PLAYLIST-TYPE` entirely +
  `EXT-X-DISCONTINUITY-SEQUENCE` + terminal ENDLIST with prune-freeze +
  client `startPosition` pin (recommended: YES; the only RFC-clean model
  that keeps retention).
- **V4** — `-copyts` permanently rejected; the run map stays the sole
  timeline bridge (recommended: YES).
- **V5** — `manifestUrl` → master.m3u8 for ALL HLS sessions, single-
  variant masters included (recommended: YES; one client path).
- **V6** — Tier 1+ advertise ALL surviving rungs, uncapped
  (recommended: YES; the law constrains Tier-0 only).
- **V7** — accept the two bounded latency trade-offs of §9.1.10
  (recommended: YES; both are consequences of LD-16's single-pipeline
  law, and both are bounded and pinned).

#### 9.1.12 Build-phase file map (single coordinated change; matrix + goldens same PR per invariant 2)

- `packages/playback-engine`: `src/stages/ladder.ts` (+ step (h) pure
  trim), `src/plan.ts` (final-assembly call site, ENGINE_VERSION
  0.11.0), `src/reasons.ts` (+ `ladder-variant-capped`), matrix cases +
  goldens (incl. the mixed-codec rung-switch argv golden, §9.1.4), the
  §7.5 regression pin.
- `packages/contract/openapi.yaml`: §9.1.2 items 1–4; SDK regen atomic.
- `packages/db`: migration 0044 (§9.1.3); `query/playback-sessions.ts`
  (+ `requestRungSwitch`); `internal/transcode-sessions.ts` (row fields,
  `recordTranscodeRun` rung field, pending-rung compare-and-clear
  consume/absorb); `getTranscodeRunForSegment` extent-rule doc comment.
- `apps/server`: master-playlist renderer (pure module beside
  `common/served-playlist.ts` + goldens); `playback/hls-file.controller.ts`
  (master route, `v{K}` pattern extension, switch-signal recording);
  `common/served-playlist.ts` (`withMediaSequence` grows the
  discontinuity-sequence emission).
- `apps/worker`: `transcode/playlist.ts` (drop EVENT tag, ENDLIST
  emission + prune-freeze); `transcode/runner.ts` (pending-rung
  consumption folded into the restart block, single-restart rule,
  `active_rung_index` writes); `transcode/rebuild-args.ts` (+ rung
  parameter); `transcode/plan-shape.ts` (rung-at-index helper).
- `apps/web`: `lib/hls-js-config.ts` (`startPosition`, `startLevel`);
  `components/player/VideoPlayer.tsx` (master URL, quality selector);
  no heartbeat changes.
- Tests, by name: `seek-rung-switch.integration.spec.ts` (§9.1.7 — the
  named scenario + process-census sampling); server e2e for master +
  `v{K}` routes + switch-signal recording + playlist-model tags
  (media-sequence / discontinuity-sequence / ENDLIST freeze); engine
  matrix per §10's C2 classes; hls-js-config unit tests for both pins;
  the Safari token-hop verification item (§9.1.9).

#### 9.1.13 Seek model V8 (owner-decision, signed 2026-08-12; amendments A1–A3 folded into the sections above)

Closes the QA-confirmed scrubber defects (2026-08-12, vs `d6f378e`):
out-of-window seeks unreachable (UA seekable clamp + live semantics made
the segment-GET trigger unreachable); the unkeepable 503 "coming soon"
promise; the throttle restart deadlock INCLUDING its latent
pure-rung-switch variant (A3); no client source-time model. Decision
record + rulings: STATE.md "Seek model V8" section. Numbering note: the
design circulated as "V6"; recorded as V8 (V1–V7 were consumed by the C2
sign-off, §9.1.11).

Build-phase file map (waves ship in order; W1/W2 are dark until W3):

- **W1 `apps/worker`** (client-agnostic): `transcode/throttle.ts` (the
  startSegment floor, new pure input), `transcode/runner.ts` (floor
  input; restart clears `suspended_by_throttle`; throttle reconciles
  every tick; start-segment collision floor), `transcode/playlist.ts`
  (§9.1.5 rule 7 PDT emission; `RunState.sourceOriginMs` threaded via
  `applyRunUpdate` from the run registry). Tests: `throttle.spec.ts`
  (floor cases incl. the pure-switch pin), `playlist.spec.ts` (PDT:
  origin-0 run, multi-run non-monotonic origins, pruned head, ENDLIST),
  `seek-rung-switch.integration.spec.ts` (seek-while-suspended,
  switch-while-throttled, collision).
- **W2 `packages/contract` + `apps/server`**: openapi.yaml
  `POST /playback/sessions/{id}/seek` (202 clamped / 404 / 409
  not-a-transcode-session / 422 / 429) + SDK regen atomic; seek handler
  (clamp via `clampSeekTargetMs` + `getMediaInfoAssembly`;
  `requestSeek`/`requestSeekWithRungSwitch` single statement);
  `hls-file.controller.ts` 503 detail reword (no "coming soon"). Tests:
  `playback-seek.e2e.spec.ts` (202+clamp incl. past-EOF, absorption,
  coincident rung → one run, 404 foreign/terminal, 409 direct-play,
  `transcode_runs` origin assertion), conformance walk.
- **W3 `apps/web`**: `lib/source-time.ts` (pure listed-window model, A2);
  `VideoPlayer.tsx` (soft/hard algorithm, `relocating` state, landing
  watch, `HARD_SEEK_LANDING_TIMEOUT_MS = 20_000`, post-ENDLIST re-arm
  (A1), re-attach pin update, buffering clears on `seeked`/`canplay`,
  PDT-derived display + heartbeat value); `Scrubber.tsx`
  (commit-on-pointerup). Tests: `source-time.test.ts` (incl.
  listed-but-unbuffered soft case), `Scrubber.test.tsx`, VideoPlayer
  hard-seek state machine incl. post-ENDLIST re-arm and
  re-seek-before-landing.

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
encoder (`libsvtav1`, `av1_nvenc`, `av1_qsv`, `av1_vaapi`, `av1_amf`);
(6) **AV1 software-route exclusion (§7.2's Stage-G residual guard)** — the
companion property 5 cannot state, because property 5's space deletes av1
from every hardware `encode` list: over randomized `policy.tier === 0`
inputs whose caps are UNRESTRICTED (hardware av1 encoders allowed, so
eligibility really reaches `'hw'` and av1 rungs really enter the ladder),
every emitted plan with `video.encoder === 'software'` satisfies the same
three clauses as property 5 — no av1 rung, no av1 `targetCodec`, no av1
encoder token. Non-vacuity floors mirror property 5's and add the two this
hypothesis needs: the guard must actually FIRE in the sample, and av1 must
actually SURVIVE on some hardware route (otherwise the property would hold
over a space where av1 never existed).
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
**C2 mandatory test classes (LD-6/LD-16, §7.5 + §9.1; numbers assigned at
build):** ENGINE/MATRIX — T0 >3-rung ladder trimmed to exactly 3 with the
§7.5 keep rule + single `ladder-variant-capped` reason (detail lists every
dropped rung); T0 ladder ≤3 → untouched, no reason; T1/T2 6-rung → never
trimmed; cap runs AFTER Stage-G replacement (T0 software route's
tier-capped 2-rung ladder → cap no-op); trim preserves `topRungOf` ⇒
`video.targetCodec` unchanged in every trimmed case; C2 regression pin =
every T1+/non-transcode/≤-3-rung case byte-identical (`engineVersion`
aside), every changed T0 case edited with `why:` per the regression law.
WORKER INTEGRATION (real ffmpeg) — the §9.1.7 named scenario
(`seek-rung-switch.integration.spec.ts`: seek→backward-seek→switch→seek,
switch-run origin EXACTLY old origin+produced, per-run derivation +
progress mapping exact across the switch boundary, extent-by-prefix ==
extent-by-next-start); ≤1-live-process census sampled across a handoff;
coincident seek+switch tick → exactly one restart; repeated same-rung
switch requests absorbed at the write side (no restart); handoff
rebuild-failure → session `failed`, slot freed only via terminal status.
SERVER E2E — master playlist golden (STREAM-INF set, BANDWIDTH/
RESOLUTION/CODECS deterministic, single-variant master for ladder-empty);
`v{K}` playlist/segment routes serve union-playlist bytes; mismatched-`K`
GET records the switch request; bare legacy paths signal nothing;
playlist-model tags (no PLAYLIST-TYPE ever, MEDIA-SEQUENCE +
DISCONTINUITY-SEQUENCE emitted iff pruned, ENDLIST emitted on completion
and prunes frozen after it); CODECS-string fence vs ffprobe of real
encoder output. CLIENT — hls-js-config `startPosition`/`startLevel` pin
units; quality-selector pin/auto; Safari master→variant token-hop
verification (build item, §9.1.9).
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
