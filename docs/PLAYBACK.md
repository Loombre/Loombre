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
}
```

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
  `dv-stripped-to-hdr10` (metadata strip in arg builder, no re-encode);
  else tone-map required, `hdr-tone-map-required`.
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
`hw-encoder-selected:*`, `software-fallback:*`.
Every reason carries `{ code, streamIndex?, detail? }`; matrix cases assert on
codes, golden tests on full objects.

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

`LadderRung { heightPx, videoBitrateBps, audioBitrateBps, codec }`.
Instance default table (policy-overridable):
2160p/16M/hevc · 1080p/8M · 1080p/4M · 720p/3M · 480p/1.5M · 360p/0.8M
(h264 below 2160 unless `hevcEncodePreferred` and device hevc → hevc, −25% bitrate).
Construction rules: never exceed source height; never exceed source bitrate;
drop rungs above `network.maxBitrateBps` (keep at least the lowest rung);
master playlist lists all surviving rungs; **each rung is a lazily started
transcode pipeline** — only the initially selected rung starts; a client ABR
switch starts the sibling rung at the requested segment. `isLocal` networks
skip the network cap but honor device caps.

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
- **Concurrency:** global semaphore = `maxSimultaneousTranscodes`; admission
  beyond it fails the session create with a typed 429 (`transcode-slots-
  exhausted`) — clients fall back to a lower-bitrate direct attempt or queue.
- **Audit:** the serialized plan + engineVersion stored on the session row at
  create; ffmpeg stderr tail (last 4 KB ring) stored on failure.
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
completeness — decision!==direct-play ⇒ ≥1 blocking-class reason.
**Golden args:** 25 canonical scenarios snapshot full token-form ffmpegArgs.
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
