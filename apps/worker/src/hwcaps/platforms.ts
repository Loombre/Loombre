// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §8.2 platform candidate order (docs/PLAYBACK.md, verbatim):
 *   macOS:   videotoolbox -> software
 *   Windows: nvenc -> qsv -> amf -> d3d11va(decode-only) -> software
 *   Linux:   nvenc -> qsv -> vaapi -> software
 *
 * Pure lookup keyed on `node:os` `platform()` — the ONLY place in this
 * module that reasons about `NodeJS.Platform` at all; battery.ts itself
 * just consumes whatever backend array it's handed (binding constraint 1:
 * "the emitted VerifiedCapabilities.backends array MUST be in platform
 * order with software LAST" — true by construction here, and re-asserted
 * by test/hwcaps/platforms.spec.ts).
 */
import type { HwBackend } from './types.js';

const CANDIDATES_BY_PLATFORM: Partial<Record<NodeJS.Platform, readonly HwBackend[]>> = {
  darwin: ['videotoolbox', 'software'],
  win32: ['nvenc', 'qsv', 'amf', 'd3d11va', 'software'],
  linux: ['nvenc', 'qsv', 'vaapi', 'software'],
};

/**
 * Candidate backends for `platform`, in §8.2 order (software always last).
 * Any platform docs/PLAYBACK.md §8.2 doesn't name (e.g. 'freebsd', tests'
 * synthetic platforms) falls back to `['software']` — every OS can at
 * least run the bundled ffmpeg's software codecs, and a battery with only
 * the universal fallback candidate is a correct (if minimal) answer rather
 * than a thrown error on an unlisted platform.
 */
export function candidatesForPlatform(platform: NodeJS.Platform): HwBackend[] {
  const known = CANDIDATES_BY_PLATFORM[platform];
  return known ? [...known] : ['software'];
}
