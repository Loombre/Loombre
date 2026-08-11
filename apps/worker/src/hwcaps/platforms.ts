// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §8.2 platform candidate order (docs/PLAYBACK.md, verbatim):
 *   macOS:   videotoolbox -> software
 *   Windows: nvenc -> qsv -> amf -> d3d11va(decode-only) -> software
 *   Linux:   nvenc -> qsv -> vaapi -> software
 *
 * Pure lookup keyed on `node:os` `platform()` PLUS the host architecture —
 * the ONLY place in this module that reasons about `NodeJS.Platform`/
 * `NodeJS.Architecture` at all; battery.ts itself just consumes whatever
 * backend array it's handed (binding constraint 1: "the emitted
 * VerifiedCapabilities.backends array MUST be in platform order with
 * software LAST" — true by construction here, and re-asserted by
 * test/hwcaps/platforms.spec.ts). Both axes arrive as ARGUMENTS, never
 * read from `process` in here: the caller (run.ts) passes
 * `process.platform`/`process.arch` as data, which is what keeps this
 * table exhaustively testable for hosts nobody in the project owns.
 */
import type { HwBackend } from './types.js';

const CANDIDATES_BY_PLATFORM: Partial<Record<NodeJS.Platform, readonly HwBackend[]>> = {
  darwin: ['videotoolbox', 'software'],
  win32: ['nvenc', 'qsv', 'amf', 'd3d11va', 'software'],
  linux: ['nvenc', 'qsv', 'vaapi', 'software'],
};

/**
 * ARCH PRUNING (LD-2, owner-adjudicated 2026-08-10). §8.2's Windows row was
 * written for x86 Windows and every entry in it is an x86 fact: nvenc
 * (NVIDIA discrete, no ARM64-Windows driver ships one), qsv (Intel iGPU —
 * an ARM64 Windows host has no Intel iGPU by definition), amf (AMD, same),
 * and d3d11va, which LOOKS architecture-neutral because D3D11 itself is —
 * but ffmpeg's d3d11va hwaccel on ARM64 Windows is a different code path
 * against Qualcomm/Microsoft SQ-series drivers that NOBODY in this project
 * has run, and the probe battery cannot distinguish "no evidence" from
 * "works". An unverified hwaccel is worse than software: it fails at
 * runtime, mid-session, after the plan has already been committed.
 *
 * So win32+arm64 gets `['software']` and nothing else.
 *
 * RE-OPEN CONDITION (record here, do not re-litigate without it): this
 * entry is removed when — and only when — the probe battery
 * (apps/worker/src/hwcaps/battery.ts) has produced a real PASS for a
 * d3d11va decode on real ARM64 Windows hardware, on a CI runner or an
 * owner-attested machine, with the run recorded in STATE.md. Adding
 * d3d11va back on reasoning alone re-creates exactly the failure mode this
 * rule exists to prevent.
 */
const ARM64_PRUNED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['win32']);

/**
 * Candidate backends for `platform`/`arch`, in §8.2 order (software always
 * last). Any platform docs/PLAYBACK.md §8.2 doesn't name (e.g. 'freebsd',
 * tests' synthetic platforms) falls back to `['software']` — every OS can
 * at least run the bundled ffmpeg's software codecs, and a battery with
 * only the universal fallback candidate is a correct (if minimal) answer
 * rather than a thrown error on an unlisted platform. `arch` is REQUIRED,
 * not defaulted: a default would silently re-admit the x86 backend list on
 * the one host combination ARM64_PRUNED_PLATFORMS exists to protect.
 */
export function candidatesForPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): HwBackend[] {
  if (arch === 'arm64' && ARM64_PRUNED_PLATFORMS.has(platform)) return ['software'];
  const known = CANDIDATES_BY_PLATFORM[platform];
  return known ? [...known] : ['software'];
}
