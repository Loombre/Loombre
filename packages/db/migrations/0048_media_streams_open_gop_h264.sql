-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0048_media_streams_open_gop_h264
--
-- Data-only, additive in effect: sets one column back to NULL on a bounded
-- set of rows. No schema change, no drops, no contract surface.
--
-- WHY. The open-GOP probe (migrations/0038) scanned HEVC only; the backfill
-- bulk-wrote open_gop = false for every other codec because the engine
-- never consulted the field for them. As of docs/PLAYBACK.md §3 Stage B′
-- (ENGINE_VERSION 0.12.0) it DOES consult it for h264 — an open-GOP h264
-- stream must not be stream-copied into a segmented container — and the
-- worker's detector now scans h264 for recovery-point SEIs. A bulk `false`
-- on an h264 row is therefore not a verdict, it is the old "not applicable"
-- value wearing a verdict's clothes. NULL = "not yet probed" puts those rows
-- back in front of the boot-time backfill (hasVideoStreamsNeedingOpenGop
-- Backfill), which scans them once and writes a real answer.

UPDATE media_streams
   SET open_gop = NULL
 WHERE stream_type = 'video'
   AND codec = 'h264'
   AND open_gop = false;
