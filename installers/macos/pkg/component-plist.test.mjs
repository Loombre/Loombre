#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/component-plist.test.mjs
//
// The rc.6 relocation bug ("install successful, app never launches or
// appears in Applications"): build-pkg.mjs ran pkgbuild WITHOUT a
// --component-plist, so pkgbuild's automatic bundle analysis marked
// Applications/Loombre.app BundleIsRelocatable=true — a <relocate> entry
// in the shipped PackageInfo. At install time PackageKit resolves a
// relocatable bundle's destination by asking LaunchServices/Spotlight for
// an EXISTING copy of the bundle id anywhere on the target volume and
// installs over THAT instead of the payload path. Observed live
// (/var/log/install.log, 2026-08-08, four consecutive installs):
//   PackageKit: Applications/Loombre.app relocated to Users/ozzy/App
//     Development/Loombre/installers/macos/.build-cache/payload/arm64/
//     Applications/Loombre.app
// The install exits 0, /Applications/Loombre.app never appears, and
// /Library/LaunchAgents/com.loombre.menubar.plist's hardcoded
// ProgramArguments path spawns nothing — the exact "successful install,
// nothing on screen, nothing in Applications" field report.
//
// This imports build-pkg.mjs's own renderComponentPlist (no reimplemented
// plist to drift from the real build path) and smoke.mjs's
// findRelocatableBundleIds (the same parser the post-build smoke check
// uses), and, where the Apple toolchain is present, round-trips both
// through the REAL pkgbuild:
//   - WITHOUT --component-plist (the defect): the detector must fire —
//     proving the smoke check would have caught the original bug;
//   - WITH the rendered component plist (the fix): no relocatable bundles
//     survive into PackageInfo.
//
// Run: node --test installers/macos/pkg/component-plist.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderComponentPlist } from "../build-pkg.mjs";
import { findRelocatableBundleIds } from "../smoke.mjs";

test("renderComponentPlist pins Applications/Loombre.app non-relocatable", () => {
  const plist = renderComponentPlist();
  assert.match(
    plist,
    /<key>RootRelativeBundlePath<\/key>\s*<string>Applications\/Loombre\.app<\/string>/,
    "component plist must name the bundle at its payload path (relative to --install-location /)",
  );
  assert.match(
    plist,
    /<key>BundleIsRelocatable<\/key>\s*<false\/>/,
    "BundleIsRelocatable must be an explicit <false/> — this key IS the fix; pkgbuild's analysis default is true",
  );
  // Version-checking is deliberately OFF: rc-suffixed versions
  // ("0.9.0-rc.6") do not compare reliably under Installer's numeric
  // segment rules, and the pkg payload is authoritative for this bundle
  // (preinstall boots the running app out first). See renderComponentPlist.
  assert.match(plist, /<key>BundleIsVersionChecked<\/key>\s*<false\/>/);
});

test("findRelocatableBundleIds parses PackageInfo's <relocate> element", () => {
  // Verbatim shape of the defective rc.6 PackageInfo (xar-extracted).
  const defective = `<pkg-info identifier="com.loombre.pkg">
    <bundle path="./Applications/Loombre.app" id="com.loombre.menubar"/>
    <relocate>
        <bundle id="com.loombre.menubar"/>
    </relocate>
</pkg-info>`;
  assert.deepEqual(findRelocatableBundleIds(defective), ["com.loombre.menubar"]);
  assert.deepEqual(findRelocatableBundleIds(`<pkg-info><bundle id="a"/></pkg-info>`), []);
  assert.deepEqual(findRelocatableBundleIds(`<pkg-info><relocate/></pkg-info>`), []);
  assert.deepEqual(findRelocatableBundleIds(`<pkg-info><relocate></relocate></pkg-info>`), []);
});

const hasAppleTools =
  process.platform === "darwin" &&
  ["pkgbuild", "pkgutil"].every((bin) => spawnSync("which", [bin]).status === 0);

/** Minimal-but-analyzable app bundle: pkgbuild's component analysis only
 *  picks up a directory as a bundle when Contents/Info.plist declares a
 *  CFBundleIdentifier, which is exactly the id relocation then hunts by. */
function stageFakeAppRoot(scratch) {
  const root = path.join(scratch, "root");
  const macosDir = path.join(root, "Applications", "Loombre.app", "Contents", "MacOS");
  mkdirSync(macosDir, { recursive: true });
  const bin = path.join(macosDir, "Loombre");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  writeFileSync(
    path.join(root, "Applications", "Loombre.app", "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.loombre.menubar</string>
  <key>CFBundleName</key><string>Loombre</string>
  <key>CFBundleExecutable</key><string>Loombre</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>9.9.9</string>
</dict>
</plist>
`,
  );
  return root;
}

function pkgbuildAndReadPackageInfo(scratch, root, label, extraArgs) {
  const componentPkg = path.join(scratch, `${label}.pkg`);
  const res = spawnSync(
    "pkgbuild",
    ["--root", root, "--identifier", "com.loombre.pkg", "--version", "9.9.9", "--install-location", "/", ...extraArgs, componentPkg],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, `pkgbuild (${label}) failed:\n${res.stderr}`);
  const expandDir = path.join(scratch, `${label}-expanded`);
  const expandRes = spawnSync("pkgutil", ["--expand", componentPkg, expandDir], { encoding: "utf8" });
  assert.equal(expandRes.status, 0, `pkgutil --expand (${label}) failed:\n${expandRes.stderr}`);
  return readFileSync(path.join(expandDir, "PackageInfo"), "utf8");
}

test(
  "the real pkgbuild: analysis default relocates the app bundle; the component plist pins it",
  { skip: hasAppleTools ? false : "pkgbuild/pkgutil unavailable on this host (non-macOS or no Xcode CLT)" },
  () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "loombre-component-plist-test-"));
    try {
      const root = stageFakeAppRoot(scratch);

      // Control — the original defect, reproduced: no --component-plist
      // means pkgbuild's own analysis marks the bundle relocatable. This
      // half proves the detector actually detects (a smoke check that
      // passes on defective input is worse than none).
      const defectiveInfo = pkgbuildAndReadPackageInfo(scratch, root, "defective", []);
      assert.deepEqual(
        findRelocatableBundleIds(defectiveInfo),
        ["com.loombre.menubar"],
        "pkgbuild without --component-plist no longer marks the bundle relocatable — if Apple changed the " +
          "analysis default, this control (and possibly the component plist itself) can be simplified",
      );

      // The fix: the rendered component plist survives the real pkgbuild
      // with zero relocatable bundles in PackageInfo.
      const componentPlistPath = path.join(scratch, "component-plist.plist");
      writeFileSync(componentPlistPath, renderComponentPlist(), "utf8");
      const pinnedInfo = pkgbuildAndReadPackageInfo(scratch, root, "pinned", ["--component-plist", componentPlistPath]);
      assert.deepEqual(
        findRelocatableBundleIds(pinnedInfo),
        [],
        "component plist did not suppress <relocate> — Loombre.app would be installed over any stray copy " +
          "on the volume instead of /Applications (the rc.6 relocation bug)",
      );
      // The bundle must still be DECLARED (id-tracked for upgrade
      // bookkeeping) — pinning is not the same as vanishing from analysis.
      assert.match(pinnedInfo, /<bundle[^>]*id="com\.loombre\.menubar"/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
