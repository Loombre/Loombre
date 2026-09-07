#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/build-linux-icons.mjs
//
// Generates the Linux icon set from the single 1024px brand source in
// design/blaze/assets/png/ (the same source scripts/build-app-icons.mjs
// packages into .icns/.ico for the other two platforms):
//
//   installers/linux/desktop/icons/hicolor/<N>x<N>/apps/loombre.png
//                                   -> /usr/share/icons/hicolor/... (the
//                                      launcher + autostart .desktop
//                                      entries' `Icon=loombre`)
//   installers/linux/desktop/icons/hicolor/scalable/apps/loombre.svg
//                                   -> the vector master, copied verbatim
//   installers/linux/tray/assets/tray-{running,stopped,attention}.png
//                                   -> embedded (go:embed) into
//                                      bin/loombre-tray as its
//                                      StatusNotifierItem pixmaps
//
// WHY THE OUTPUTS ARE COMMITTED (same reasoning as build-app-icons.mjs):
// the release tarball is built on a Linux runner with no image tooling
// beyond what the repo carries, and the tray binary is a plain
// `go build` that embeds whatever PNG bytes sit next to its source. Keeping
// the rendered files in git keeps both builds hermetic; this script keeps
// them regenerable. Re-run after any change to the source art.
//
// Uses the `sharp` already present in the workspace (apps/worker's image
// pipeline dependency) — no new dependency, no macOS-only tool.
//
// Usage: node scripts/build-linux-icons.mjs

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(join(REPO_ROOT, "apps", "worker", "package.json"));
const sharp = require("sharp");

const SOURCE_PNG = join(REPO_ROOT, "design", "blaze", "assets", "png", "loombre-app-icon-amber-1024.png");
const SOURCE_SVG = join(REPO_ROOT, "design", "blaze", "assets", "svg", "loombre-app-icon-amber.svg");
const HICOLOR_DIR = join(REPO_ROOT, "installers", "linux", "desktop", "icons", "hicolor");
const TRAY_ASSETS_DIR = join(REPO_ROOT, "installers", "linux", "tray", "assets");

// freedesktop hicolor sizes desktops actually look up for an app icon
// (16/22/24 = panels and menus, 32/48 = file managers, 64/128/256 = launchers,
// HiDPI scaling). 512 is what GNOME's app grid prefers on 2x displays.
const HICOLOR_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];

// StatusNotifierItem pixmaps: hosts scale, but 64px is the sweet spot
// (22/24 logical px at 2x-3x without visible softening).
const TRAY_SIZE = 64;

async function main() {
  for (const size of HICOLOR_SIZES) {
    const dir = join(HICOLOR_DIR, `${size}x${size}`, "apps");
    mkdirSync(dir, { recursive: true });
    await sharp(SOURCE_PNG).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(join(dir, "loombre.png"));
  }
  mkdirSync(join(HICOLOR_DIR, "scalable", "apps"), { recursive: true });
  copyFileSync(SOURCE_SVG, join(HICOLOR_DIR, "scalable", "apps", "loombre.svg"));

  mkdirSync(TRAY_ASSETS_DIR, { recursive: true });
  const base = sharp(SOURCE_PNG).resize(TRAY_SIZE, TRAY_SIZE, { kernel: "lanczos3" });
  // running: the brand icon as-is.
  await base.clone().png({ compressionLevel: 9 }).toFile(join(TRAY_ASSETS_DIR, "tray-running.png"));
  // stopped / starting / stopping: desaturated and dimmed — recognisably
  // "the Loombre icon, but off".
  await base.clone().greyscale().modulate({ brightness: 0.85 }).png({ compressionLevel: 9 }).toFile(join(TRAY_ASSETS_DIR, "tray-stopped.png"));
  // attention (crashed / degraded / contract mismatch): a red tint.
  await base.clone().tint({ r: 232, g: 78, b: 60 }).png({ compressionLevel: 9 }).toFile(join(TRAY_ASSETS_DIR, "tray-attention.png"));

  console.log(`[build-linux-icons] wrote ${HICOLOR_SIZES.length} hicolor PNGs + scalable SVG under ${HICOLOR_DIR}`);
  console.log(`[build-linux-icons] wrote 3 tray pixmaps under ${TRAY_ASSETS_DIR}`);
}

main().catch((err) => {
  console.error(`[build-linux-icons] ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
