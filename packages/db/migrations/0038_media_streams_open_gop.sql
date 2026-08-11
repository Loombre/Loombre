-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0038_media_streams_open_gop
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010's discipline): no
-- column drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified playback defect: HEVC sources encoded with open GOPs
-- (CRA keyframes + RASL leading pictures) cause full-frame white decode
-- smears in MSE playback for a few seconds after a seek-restart
-- stream-copy transcode run. @loombre/playback-engine (ENGINE_VERSION
-- 0.8.4, packages/playback-engine/src/types.ts's VideoStream.openGop)
-- consults this per-video-stream fact to decide whether a withSeek copy
-- run needs `-bsf:v filter_units=remove_types=8-9` (strips the RASL_N/
-- RASL_R leading-picture NAL units that decode into the smear) — see that
-- package's args/builder.ts.
--
-- NULL means "not yet probed for this fact" (video-only, mirrors 0002's
-- hdr/dv_profile/interlaced NULL convention) — distinct from `false`
-- ("probed and confirmed closed-GOP"). The probe pipeline
-- (apps/worker/src/probe) only ever positively detects `true`; every
-- other case (non-HEVC streams, a scan failure/timeout, or a legacy row
-- predating this column) stays `false`/NULL rather than guessing `true`
-- — packages/db/src/query/media-info.ts and src/internal/media-assembly.ts
-- map NULL -> false when assembling the docs/PLAYBACK.md §2.1 MediaInfo
-- shape (conservative: never strip GOP-boundary NALs unless positively
-- detected). apps/worker/src/probe/opengop-backfill-consumer.ts sweeps
-- pre-existing hevc rows still NULL; every non-hevc NULL row is bulk-set
-- false directly in SQL (no scan needed, since the engine only ever
-- consults this field for hevc video streams).

ALTER TABLE media_streams ADD COLUMN open_gop BOOLEAN NULL;

COMMENT ON COLUMN media_streams.open_gop IS
  'Video-only (docs/PLAYBACK.md §2.1 VideoStream.openGop / '
  '@loombre/playback-engine''s VideoStream.openGop). true = a bounded '
  'ffmpeg `trace_headers` NAL scan (apps/worker/src/probe) found a '
  'CRA_NUT/BLA keyframe as a non-first keyframe or a RASL_N/RASL_R leading '
  'picture — open-GOP HEVC, needs the seek-restart RASL-strip bitstream '
  'filter. false = confirmed closed-GOP (IDR-only) OR a non-HEVC stream '
  '(the engine never consults this field for non-hevc codecs). NULL = not '
  'yet probed for this fact (legacy row predating this column, or the scan '
  'failed/timed out — never guessed true). See migrations/0002_phase1_'
  'catalog.sql''s hdr/dv_profile/interlaced columns for the same '
  'video-only-NULL convention this mirrors.';
