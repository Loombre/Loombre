# Raw ffprobe JSON fixtures

These are checked-in raw `ffprobe -v error -print_format json -show_format
-show_streams -show_chapters` outputs (or, where noted, hand-authored JSON
of the same shape). No media binaries are committed — only JSON. Generated
with ffmpeg/ffprobe 8.1.1 (`/opt/homebrew/bin/ffmpeg`) on macOS via
`lavfi testsrc2`/`sine` synthetic sources, mirroring the fixture generator's
own approach (docs/PLAYBACK.md §8.1/§10).

## Real (probed against actual encoded media)

| File | Source |
|---|---|
| `01_h264_aac.json` | `libx264` (High profile, 8-bit) + `aac` in mp4 |
| `02_hevc10_hdr10.json` | `libx265` Main10 10-bit + `setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc` in mkv |
| `06_mpeg2_interlaced_ac3.json` | `mpeg2video -flags +ildct+ilme -top 1` + `ac3` in mpegts |
| `07_flac_5_1.json` | `flac`, 6-channel (`pan=5.1`) |
| `08_mp3.json` | `libmp3lame` with ID3v2.3 tags |
| `09a_subrip.json` / `09b_ass.json` / `09c_mov_text.json` | `subrip`/`ass`/`mov_text` subtitle encoders, muxed from a real `.srt` source |
| `12_webm_vp9_opus.json` | `libvpx-vp9` + `libopus` in webm — used to verify the mkv/webm `format_name` disambiguation heuristic with NO filename hint |
| `13_m4a.json` | `aac`-only mux with `.m4a` extension — `format.tags.major_brand` is `'M4A '` |
| `14_mov.json` | `libx264`+`aac` muxed with `-f mov` — `format.tags.major_brand` is `'qt  '` |
| `15_hevc10_hlg.json` | Same as 02 but `color_trc=arib-std-b67` (HLG) |

`10_missing_bitrate.json` and `11_subtitle_set_mixed.json` are derived from
the real captures above (bit_rate fields stripped / subtitle streams from
09a-c stitched together with hand-authored bitmap-subtitle streams — see
below), not independently re-probed.

**HEVC `level` note:** `02_hevc10_hdr10.json` really does report
`"level": 63` for a Main10 stream that is level 2.1 in human terms
(HEVC's `general_level_idc` = 30 × real level, vs. h264's `level_idc` being
10 × real level). extract.ts passes `level` through unchanged for every
codec rather than reinterpreting it — see the DECISION comment on
`normalizeLevel` in `apps/worker/src/probe/extract.ts`.

## Hand-authored (real feature not producible with this repo's tooling)

FFmpeg cannot encode these locally: Dolby Vision RPU metadata, TrueHD/E-AC-3
Atmos object-audio bitstreams, and bitmap subtitle codecs (`hdmv_pgs_subtitle`
/ `dvd_subtitle` / `dvb_subtitle`) all require proprietary encoders/inputs
this ffmpeg build doesn't have — bitmap subtitle encoders explicitly refuse
text input ("Subtitle encoding currently only possible from text to text or
bitmap to bitmap", confirmed by trying it). Each fixture below is
hand-authored JSON, shaped to match the real disposition/tags/stream
structure observed in the real fixtures above, with the codec-specific
fields sourced as noted.

| File | What it claims | Source of the shape |
|---|---|---|
| `03_hevc_dv8_blcompat1.json` | HEVC, DV profile 8, `dv_bl_signal_compatibility_id: 1` (HDR10-compatible base layer) | Real `02_hevc10_hdr10.json` video stream + an injected `side_data_list` "DOVI configuration record" entry. Field names (`dv_profile`, `dv_bl_signal_compatibility_id`, `rpu_present_flag`, etc.) are FFmpeg's own struct field names from `libavutil/dovi_meta.h` (`AVDOVIDecoderConfigurationRecord`) as printed by `ffprobe.c`'s side-data writer — NOT independently verified against a live probe in this environment (no local DV sample). Flagged in code (`findDoviSideData` docstring). |
| `03b_hevc_dv5.json` | HEVC, DV profile 5 (single-layer, no compatible base) | Same DOVI shape as above, `bl_present_flag: 0`, `dv_bl_signal_compatibility_id: 0`. Same caveat. |
| `04_truehd_atmos.json` | TrueHD 7.1 core with Atmos | `profile: "Dolby TrueHD + Dolby Atmos"` — FFmpeg's `FF_PROFILE_TRUEHD_ATMOS` name from `libavcodec/profiles.c` (`ff_truehd_profiles`). Not locally verifiable: this ffmpeg build's `truehd` encoder is experimental and rejected the encode attempt made while building this fixture set. |
| `05_eac3_joc.json` | E-AC-3 with Dolby Atmos (JOC) | `profile: "Dolby Digital Plus + Dolby Atmos"` — FFmpeg's `FF_PROFILE_EAC3_DDP_ATMOS` name from the same `libavcodec/profiles.c` table. JOC encoding is proprietary; not producible with open-source `eac3`. A plain (non-Atmos) `eac3` WAS probed locally and confirmed `profile: null` for the base case — see `resolveHasAtmos`/`mapAudioCodec` docstrings in extract.ts. |
| `11_subtitle_set_mixed.json` subtitle streams `pgs`/`vobsub`/`dvbsub`/unknown (`microdvd`) | Bitmap/unknown subtitle codecs | `codec_name` values (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`) verified as real FFmpeg codec IDs via `ffmpeg -codecs` locally; stream *shape* (disposition/tags/timing fields) copied from the real subrip/ass/mov_text captures in this same fixture. `microdvd` is a real but PLAYBACK.md-unmapped subtitle codec, used to exercise the `'unknown'` fallback. |
| `16_unknown_and_skipped.json` | Unknown video/audio codec fallback + attachment/data stream skipping | `prores`/`wmapro` are real FFmpeg codec names outside the closed VideoCodec/AudioCodec unions (used to prove the `'unknown'` fallback); `codec_type: "attachment"`/`"data"` streams are hand-added to prove extract.ts skips them entirely. |

## Regenerating

`/private/tmp/.../scratchpad/fixgen/gen.sh` (real captures) and
`build_mixed_subs.py`/`build_handauthored.py` (derived + hand-authored) were
used to produce these — not checked in (scratch tooling, not part of the
deliverable); `scripts/gen-media-fixtures.mjs` is the checked-in, repo-owned
equivalent for the integration-test media set under `test-fixtures/media/`.
