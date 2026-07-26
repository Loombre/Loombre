#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/fetch-ffmpeg.mjs
//
// scripts/fetch-ffmpeg.mjs (lane I1) HAS LANDED — this wraps the real
// thing. Its own exported surface is CLI-args-only (no programmatic fetch
// function; see that file's own "Design note" header for why: only its
// pure/network-free helpers are exported, the actual network+extract path
// runs only past its `isDirectEntrypoint` guard) — so this invokes it
// exactly as documented (`node scripts/fetch-ffmpeg.mjs --platform
// <name> --vendor-dir <dir>`), then reads the PROVENANCE.json it writes to
// find the vendored ffmpeg/ffprobe paths. installers/macos/LAYOUT.md §8
// has the original placeholder rationale (kept for history + as the
// fallback path below, exercised only if this script is ever absent
// again).
//
// *** SECURITY CAUTION carried over from installers/ffmpeg-manifest.json's
// macos-arm64 entry (lane I1's own flagged discovery, addressed to this
// lane): the sha256 fetch-ffmpeg.mjs verifies against does NOT match the
// checksum osxexperts.net prints on its own webpage for the same URL —
// lane I1's manifest pins the hash of the bytes IT actually downloaded and
// independently hashed (so tampering AFTER that pin is still caught by
// the verify step below), but the webpage-vs-actual mismatch itself is
// unexplained beyond "most likely a stale printed checksum" and was
// explicitly left for THIS lane to re-verify before any release build.
// This script performs the best further verification available in this
// lane's scope (an ffmpeg -version banner license-flag check, see
// verifyMacosArm64License below) and prints its result loudly either way,
// but does NOT independently re-fetch from a second source — see
// installers/macos/LAYOUT.md §8 and this lane's final report for the
// full caveat. ***

import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const REAL_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "fetch-ffmpeg.mjs");

function which(bin) {
  const res = spawnSync("which", [bin], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/** Best-effort further check on lane I1's flagged macos-arm64 discovery
 *  (see module header): confirms the vendored ffmpeg's OWN `-version`
 *  banner is self-consistent with the manifest's `licenseNote` claim
 *  (GPL, libx264/libx265 present, no --enable-version3 flag in the
 *  reported configuration string => GPL-2.0-or-later per FFmpeg's own
 *  convention, matching the manifest). This does NOT resolve the
 *  webpage-checksum mismatch (that needs an out-of-band second source,
 *  out of this script's scope) — it only proves the binary that was
 *  ACTUALLY fetched is internally consistent with what the manifest
 *  claims about it, which is the one additional thing checkable here. */
function verifyMacosArm64License(ffmpegPath) {
  const res = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
  const banner = (res.stdout ?? "") + (res.stderr ?? "");
  const hasGpl = /--enable-gpl\b/.test(banner);
  const hasVersion3 = /--enable-version3\b/.test(banner);
  const hasX264 = /--enable-libx264\b/.test(banner);
  const hasX265 = /--enable-libx265\b/.test(banner);
  const versionLine = banner.split("\n")[0] ?? "";
  console.log(`[fetch-ffmpeg] macos-arm64 license self-check: ${versionLine}`);
  console.log(
    `[fetch-ffmpeg]   --enable-gpl=${hasGpl} --enable-version3=${hasVersion3} ` +
      `--enable-libx264=${hasX264} --enable-libx265=${hasX265}`,
  );
  const consistent = hasGpl && !hasVersion3 && hasX264 && hasX265;
  console.log(
    consistent
      ? "[fetch-ffmpeg]   CONSISTENT with manifest's GPL-2.0-or-later claim (gpl+libx264+libx265, no version3 flag)."
      : "[fetch-ffmpeg]   *** INCONSISTENT with manifest's license claim — STOP, do not ship, escalate to owner. ***",
  );
  if (!consistent) {
    throw new Error(
      "fetch-ffmpeg: macos-arm64 binary's own -version banner does not match the manifest's license claim — " +
        "refusing to proceed. See installers/ffmpeg-manifest.json's macos-arm64 verification.notes.",
    );
  }
  return { consistent, versionLine };
}

/** fetchFfmpeg({ platform, arch, destDir }) -> { ffmpegPath, ffprobePath, version, placeholder } */
export async function fetchFfmpeg({ platform, arch, destDir }) {
  if (!existsSync(REAL_SCRIPT_PATH)) {
    return fetchFfmpegPlaceholderFallback({ arch, destDir });
  }

  const manifestPlatform = `macos-${arch}`; // matches installers/ffmpeg-manifest.json + @loombre/release-manifest's ArtifactPlatform naming
  const vendorDir = path.join(REPO_ROOT, "vendor", "ffmpeg");

  console.log(`[fetch-ffmpeg] invoking scripts/fetch-ffmpeg.mjs --platform ${manifestPlatform}`);
  const res = spawnSync(
    process.execPath,
    [REAL_SCRIPT_PATH, "--platform", manifestPlatform, "--vendor-dir", vendorDir],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  if (res.status !== 0) {
    throw new Error(`fetch-ffmpeg: scripts/fetch-ffmpeg.mjs --platform ${manifestPlatform} failed (exit ${res.status})`);
  }

  const vendorPlatformDir = path.join(vendorDir, manifestPlatform);
  const provenancePath = path.join(vendorPlatformDir, "PROVENANCE.json");
  if (!existsSync(provenancePath)) {
    throw new Error(`fetch-ffmpeg: expected ${provenancePath} after a successful fetch — script's output layout changed?`);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const ffmpegSrc = path.join(vendorPlatformDir, provenance.components.ffmpeg.vendoredAs);
  const ffprobeSrc = path.join(vendorPlatformDir, provenance.components.ffprobe.vendoredAs);

  mkdirSync(destDir, { recursive: true });
  const ffmpegDest = path.join(destDir, "ffmpeg");
  const ffprobeDest = path.join(destDir, "ffprobe");
  copyFileSync(ffmpegSrc, ffmpegDest);
  copyFileSync(ffprobeSrc, ffprobeDest);
  chmodSync(ffmpegDest, 0o755);
  chmodSync(ffprobeDest, 0o755);

  // vendor's LICENSE.txt (when the archive shipped one) travels alongside,
  // matching provenance's aggregation/licensing posture (module header).
  const licenseSrc = path.join(vendorPlatformDir, "LICENSE.txt");
  if (existsSync(licenseSrc)) copyFileSync(licenseSrc, path.join(destDir, "LICENSE.txt"));

  if (manifestPlatform === "macos-arm64") {
    verifyMacosArm64License(ffmpegDest);
  }

  const versionRes = spawnSync(ffmpegDest, ["-version"], { encoding: "utf8" });
  const versionLine = versionRes.stdout?.split("\n")[0] ?? "unknown";
  console.log(`[fetch-ffmpeg] staged real pinned build: ${versionLine} (${provenance.license})`);

  return { ffmpegPath: ffmpegDest, ffprobePath: ffprobeDest, version: versionLine, placeholder: false };
}

/** Fallback used only if scripts/fetch-ffmpeg.mjs is ever absent again
 *  (kept for resilience/history — see module header). */
async function fetchFfmpegPlaceholderFallback({ arch, destDir }) {
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  if (arch !== hostArch) {
    throw new Error(
      `fetch-ffmpeg PLACEHOLDER FALLBACK: cannot stage a darwin-${arch} ffmpeg from this darwin-${hostArch} host ` +
        `and scripts/fetch-ffmpeg.mjs is absent.`,
    );
  }
  const ffmpegSrc = process.env.LOOMBRE_HOST_FFMPEG ?? which("ffmpeg");
  const ffprobeSrc = process.env.LOOMBRE_HOST_FFPROBE ?? which("ffprobe");
  if (!ffmpegSrc || !ffprobeSrc) {
    throw new Error("fetch-ffmpeg PLACEHOLDER FALLBACK: no host ffmpeg/ffprobe found and scripts/fetch-ffmpeg.mjs is absent.");
  }
  mkdirSync(destDir, { recursive: true });
  const ffmpegDest = path.join(destDir, "ffmpeg");
  const ffprobeDest = path.join(destDir, "ffprobe");
  copyFileSync(ffmpegSrc, ffmpegDest);
  copyFileSync(ffprobeSrc, ffprobeDest);
  chmodSync(ffmpegDest, 0o755);
  chmodSync(ffprobeDest, 0o755);
  const versionRes = spawnSync(ffmpegDest, ["-version"], { encoding: "utf8" });
  const versionLine = versionRes.stdout?.split("\n")[0] ?? "unknown";
  writeFileSync(
    path.join(destDir, "PLACEHOLDER.txt"),
    `THIS IS NOT THE PINNED LOOMBRE FFMPEG BUNDLE — scripts/fetch-ffmpeg.mjs was absent when this build ran.\n` +
      `Copied from the build host's own ffmpeg/ffprobe (${ffmpegSrc}, ${ffprobeSrc}). Host version: ${versionLine}\n`,
    "utf8",
  );
  return { ffmpegPath: ffmpegDest, ffprobePath: ffprobeDest, version: versionLine, placeholder: true };
}
