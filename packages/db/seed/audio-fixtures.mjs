#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/seed/audio-fixtures.mjs
//
// Real, tiny audio blobs behind the seeded Music library (d3-m1).
//
// seed/seed.mjs used to create 1 artist + 2 albums + 6 tracks with NO
// media_files rows at all, so getMediaInfoAssembly (src/query/media-info.ts)
// returned undefined for every track and apps/server answered every music
// POST /playback/sessions with 404 "Item or media file not found." — the
// MiniPlayerBar mounted and was skipped away within ~40 ms and no seeded
// music could EVER play in the dev stack. Rows alone don't fix that: the
// session's file GET (apps/server/src/playback/session-file.controller.ts)
// `stat()`s media_files.path and 404s when nothing is there. So the seed
// needs real files.
//
// Same posture as scripts/gen-media-fixtures.mjs, which owns the probe
// pipeline's fixtures: generate with ffmpeg's lavfi `sine` source into
// test-fixtures/media/ (gitignored — real binaries are never committed,
// only the generator), idempotent (an existing non-empty file is left
// alone), and a MISSING ffmpeg is a clean, reported skip rather than a
// crash (P1.9 spirit). ffmpeg resolution mirrors apps/worker/src/probe/
// ffprobe.ts's resolveFfmpeg() (LOOMBRE_FFMPEG, else a PATH lookup),
// inlined here for the same reason that script inlines it: seed/ is a
// zero-workspace-dependency fixture tool.
//
// Format choice — mp3, 44.1 kHz stereo, 64 kbps CBR:
//   * every browser direct-plays it (apps/web/src/lib/device-profile.ts
//     probes `audio/mpeg` for BOTH the container and the codec), so the
//     seeded library exercises the direct-play path the music player
//     actually ships, with no transcode slot involved;
//   * `mp3` is a real member of the Container AND AudioCodec enums
//     (packages/playback-engine/src/types.ts) and of session-file.
//     controller.ts's CONTENT_TYPE_BY_CONTAINER map;
//   * ~8 kB/s, so a whole 6-track seeded library is well under half a
//     megabyte of disk.
//
// Durations are SECONDS, not minutes, and deliberately differ per track
// (5-10 s): long enough to cross lib/gapless.ts's 3 s near-end preload
// threshold and actually exercise the gapless handoff by hand, short enough
// that the fixtures stay trivial.

import { accessSync, constants as fsConstants, existsSync, mkdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/db/seed -> repo root. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

const BITRATE_BPS = 64_000;
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;

export const SEED_AUDIO_CONTAINER = 'mp3';
export const SEED_AUDIO_CODEC = 'mp3';
export const SEED_AUDIO_BITRATE_BPS = BITRATE_BPS;
export const SEED_AUDIO_SAMPLE_RATE = SAMPLE_RATE;
export const SEED_AUDIO_CHANNELS = CHANNELS;

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name) {
  const pathEnv = process.env['PATH'] ?? process.env['Path'] ?? '';
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const extensions = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** LOOMBRE_FFMPEG first, then PATH — resolveFfmpeg()'s order. */
export function resolveFfmpeg() {
  const override = process.env['LOOMBRE_FFMPEG'];
  if (override && override.length > 0) return isExecutableFile(override) ? override : null;
  return findOnPath('ffmpeg');
}

/** Where the blobs live. `realpathSync` so a git WORKTREE (whose
 *  test-fixtures/ is a symlink into the primary checkout) stores the
 *  canonical path in media_files.path — a row that keeps resolving after
 *  that worktree is removed. */
export function seedAudioDir() {
  const dir = join(REPO_ROOT, 'test-fixtures', 'media', 'audio');
  mkdirSync(dir, { recursive: true });
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Bytes a `durationMs` CBR mp3 occupies, ignoring the few hundred bytes of
 *  header/tag — only used to keep media_files.size_bytes non-zero on a box
 *  with no ffmpeg, where no real file exists to stat. */
function estimateSizeBytes(durationMs) {
  return Math.round((durationMs / 1000) * (BITRATE_BPS / 8));
}

/**
 * Generate (once) one tone file per spec and describe what is on disk.
 *
 * @param {Array<{ slug: string, durationMs: number, frequencyHz: number }>} specs
 * @param {{ force?: boolean, log?: (msg: string) => void }} [options]
 * @returns {{ ffmpeg: string | null, dir: string, files: Array<{ slug: string, path: string, durationMs: number, sizeBytes: number, generated: boolean, present: boolean }> }}
 */
export function ensureSeedAudioFixtures(specs, options = {}) {
  const log = options.log ?? ((msg) => console.log(msg));
  const dir = seedAudioDir();
  const ffmpeg = resolveFfmpeg();

  if (!ffmpeg) {
    log(
      'seed: ffmpeg not found (LOOMBRE_FFMPEG / PATH) — seeded music rows are written, but their audio files are NOT. ' +
        'Install ffmpeg and re-run `pnpm db:seed` to make the seeded Music library actually play.'
    );
  }

  const files = specs.map((spec) => {
    const path = join(dir, `${spec.slug}.${SEED_AUDIO_CONTAINER}`);
    const durationSec = (spec.durationMs / 1000).toFixed(3);

    let present = existsSync(path) && statSync(path).size > 0;
    if (present && options.force) {
      unlinkSync(path);
      present = false;
    }

    let generated = false;
    if (!present && ffmpeg) {
      // A quarter-second fade at each end so a dev listening to the seeded
      // library gets a tone, not a click. `-y` plus the unlink above keeps
      // this non-interactive.
      const filter =
        `sine=frequency=${spec.frequencyHz}:duration=${durationSec}:sample_rate=${SAMPLE_RATE},` +
        `volume=0.15,afade=t=in:st=0:d=0.25,afade=t=out:st=${((spec.durationMs - 250) / 1000).toFixed(3)}:d=0.25`;
      const result = spawnSync(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', filter,
          '-ac', String(CHANNELS),
          '-c:a', 'libmp3lame', '-b:a', String(BITRATE_BPS / 1000) + 'k',
          path,
        ],
        // seed.mjs calls this from inside its BEGIN/COMMIT — a wedged
        // ffmpeg must never hold that transaction open indefinitely.
        { encoding: 'utf8', timeout: 20_000 }
      );
      if (result.status === 0 && existsSync(path) && statSync(path).size > 0) {
        generated = true;
        present = true;
      } else {
        log(`seed: could not generate ${path} (ffmpeg exit ${result.status}): ${(result.stderr ?? '').trim()}`);
      }
    }

    return {
      slug: spec.slug,
      path,
      durationMs: spec.durationMs,
      sizeBytes: present ? statSync(path).size : estimateSizeBytes(spec.durationMs),
      generated,
      present,
    };
  });

  const made = files.filter((f) => f.generated).length;
  const reused = files.filter((f) => f.present && !f.generated).length;
  if (ffmpeg) log(`seed: audio fixtures in ${dir} — ${made} generated, ${reused} reused.`);

  return { ffmpeg, dir, files };
}
