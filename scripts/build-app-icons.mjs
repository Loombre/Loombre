#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/build-app-icons.mjs
//
// Generates the two PLATFORM ICON CONTAINERS the installers need, from the
// single 1024px brand source in design/blaze/assets/png/:
//
//   design/blaze/assets/icons/loombre.icns   -> /Applications/Loombre.app
//   design/blaze/assets/icons/loombre.ico    -> Loombre.Tray.exe, the MSI's
//                                               ARPPRODUCTICON, the Start
//                                               Menu shortcut, the Burn
//                                               bundle
//
// WHY THE OUTPUTS ARE COMMITTED rather than generated during each build:
// the .ico is consumed on a WINDOWS runner, which has neither `sips` nor
// `iconutil` (both are macOS-only). A build-time-only generator would mean
// the Windows lane could never produce an icon at all. Committing the
// containers keeps the Windows build hermetic while this script keeps them
// REGENERABLE and their provenance obvious — re-run it after any change to
// the source art. design/blaze/README.md is the authority on the art
// itself; this script only repackages it.
//
// The .ico is written by hand rather than shelled out to ImageMagick: the
// format is a 6-byte header plus one 16-byte directory entry per image,
// and every Windows version since Vista reads PNG-compressed entries
// directly. Hand-writing it costs ~30 lines and avoids adding a system
// tool dependency (or an npm one — see LICENSE-INTENT.md) to the icon
// pipeline of a project that otherwise vendors nothing for this.
//
// Usage: node scripts/build-app-icons.mjs        (macOS only)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SOURCE_PNG = join(REPO_ROOT, "design", "blaze", "assets", "png", "loombre-app-icon-amber-1024.png");
const OUT_DIR = join(REPO_ROOT, "design", "blaze", "assets", "icons");

// Windows shows the 16/32/48 sizes in Explorer lists, the Start Menu and
// Add/Remove Programs; 256 is what the modern shell scales from. Anything
// larger is wasted bytes in an .ico.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fail(message) {
  console.error(`[build-app-icons] ${message}`);
  process.exit(1);
}

function sipsResize(source, size, destPath) {
  execFileSync("sips", ["-z", String(size), String(size), source, "--out", destPath], { stdio: "pipe" });
}

/** Minimal ICO writer: ICONDIR + ICONDIRENTRY[] + PNG payloads. */
function writeIco(pngBuffers, destPath) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16);
    // 256 is encoded as 0 in a single byte — the format's documented
    // convention for "256 or larger", and the reason ICO_SIZES stops there.
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette count (0 = truecolor)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  writeFileSync(destPath, Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]));
}

function buildIco(scratch) {
  const buffers = [];
  for (const size of ICO_SIZES) {
    const out = join(scratch, `icon-${size}.png`);
    sipsResize(SOURCE_PNG, size, out);
    buffers.push({ size, data: readFileSync(out) });
  }
  const destPath = join(OUT_DIR, "loombre.ico");
  writeIco(buffers, destPath);
  console.log(`[build-app-icons] wrote ${destPath} (${ICO_SIZES.join(", ")} px)`);
}

function buildIcns(scratch) {
  // iconutil requires this exact .iconset naming convention; it rejects
  // the directory outright if a required size is missing or misnamed.
  const iconset = join(scratch, "loombre.iconset");
  mkdirSync(iconset, { recursive: true });
  const entries = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of entries) {
    sipsResize(SOURCE_PNG, size, join(iconset, name));
  }
  const destPath = join(OUT_DIR, "loombre.icns");
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", destPath], { stdio: "pipe" });
  console.log(`[build-app-icons] wrote ${destPath}`);
}

function main() {
  if (process.platform !== "darwin") {
    fail("this generator needs macOS (`sips` + `iconutil`). The generated containers are COMMITTED precisely so other platforms never have to run it.");
  }
  if (!existsSync(SOURCE_PNG)) fail(`missing brand source art at ${SOURCE_PNG}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const scratch = mkdtempSync(join(tmpdir(), "loombre-icons-"));
  try {
    buildIco(scratch);
    buildIcns(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
