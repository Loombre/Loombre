#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/scripts/build.mjs
//
// Compiles native/ (the Go glue over golang.zx2c4.com/wireguard's device +
// tun/netstack, RG1/RG2) into a per-OS c-shared library under dist/, named
// wg-native-<platform>-<arch>.<ext> (src/platform.ts is the ONE other place
// that knows this naming scheme — keep both in sync). Builds for the
// CURRENT host only: CI's per-OS matrix legs (ci.yml) each run this
// natively on their own runner, so no cross-compilation is attempted here.
//
// Go not installed: graceful, LOUD skip locally (this package's tests then
// self-skip via test/support/require-wg.ts, same posture as
// apps/worker/test/support/require-ffmpeg.ts) — EXCEPT when
// LOOMBRE_REQUIRE_WG=1, which turns "Go not found" into a hard failure so a
// misconfigured CI runner can never silently report the wg-gated suites as
// "0 tests, fine" (the Phase 3 step 7 lesson this repo already learned once
// for ffmpeg). A Go toolchain that IS present but fails to actually compile
// is ALWAYS a hard failure, regardless of LOOMBRE_REQUIRE_WG — that is a
// real bug, never a "just skip it" situation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = join(PKG_ROOT, "native");
const DIST_DIR = join(PKG_ROOT, "dist");

const REQUIRE_WG = process.env["LOOMBRE_REQUIRE_WG"] === "1";

function platformExt(platform) {
  if (platform === "darwin") return "dylib";
  if (platform === "win32") return "dll";
  return "so";
}

function artifactName(platform = process.platform, arch = process.arch) {
  return `wg-native-${platform}-${arch}.${platformExt(platform)}`;
}

function goAvailable() {
  try {
    execFileSync("go", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!goAvailable()) {
    const message =
      "wg-native: Go toolchain not found on PATH — skipping the native build. " +
      "packages/wg-native's runtime loader (src/loader.ts) and wg-gated test " +
      "suites will report unavailable and skip gracefully. Install Go " +
      "(https://go.dev/dl/) and re-run `pnpm --filter @loombre/wg-native build` " +
      "to build the real listener.";
    if (REQUIRE_WG) {
      console.error(message);
      console.error("wg-native: LOOMBRE_REQUIRE_WG=1 is set — refusing to silently skip.");
      process.exit(1);
    }
    console.warn(message);
    return;
  }

  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });

  const outFile = join(DIST_DIR, artifactName());
  const outHeader = outFile.replace(/\.(dylib|dll|so)$/, ".h");

  const goEnv = { ...process.env, CGO_ENABLED: "1" };
  // `go build` needs a build-cache directory, which it derives from GOCACHE
  // or, failing that, the OS user-cache location (os.UserCacheDir): on
  // Windows that is %LocalAppData% ONLY, on Linux $XDG_CACHE_HOME || $HOME,
  // on macOS $HOME. Windows CI legs run this build through turbo → pnpm →
  // node, and that spawn chain reached `go` WITHOUT %LocalAppData%, so go
  // aborted before compiling: "build cache is required, but could not be
  // located." Provide a stable fallback ONLY when go would otherwise have no
  // location — a no-op on every environment that already has one (all local
  // dev + the working Linux/macOS legs), so it disturbs nothing that works.
  const hasGoCacheLocation =
    goEnv["GOCACHE"] ||
    (process.platform === "win32" ? goEnv["LOCALAPPDATA"] : goEnv["XDG_CACHE_HOME"] || goEnv["HOME"]);
  if (!hasGoCacheLocation) {
    goEnv["GOCACHE"] = join(tmpdir(), "loombre-wg-native-go-build-cache");
  }

  console.log(`wg-native: building ${outFile} (go build -buildmode=c-shared)...`);
  try {
    execFileSync("go", ["build", "-buildmode=c-shared", "-o", outFile, "."], {
      cwd: NATIVE_DIR,
      stdio: "inherit",
      env: goEnv,
    });
  } catch (err) {
    console.error(`wg-native: go build failed — ${err.message}`);
    process.exit(1);
  }

  console.log(`wg-native: built ${outFile}`);
  if (existsSync(outHeader)) console.log(`wg-native: generated header ${outHeader} (unused by the koffi loader, harmless byproduct of -buildmode=c-shared)`);
}

main();
