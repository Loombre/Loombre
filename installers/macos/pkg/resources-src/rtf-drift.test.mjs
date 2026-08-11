#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/resources-src/rtf-drift.test.mjs
//
// W17 (item 8, Wave A): the welcome/readme/conclusion
// Installer panes are GENERATED — README.txt in this directory documents
// the exact regen command, `textutil -convert rtf <pane>.html -output
// ../resources/<pane>.rtf` — but nothing enforced that the committed .rtf
// actually reflects the committed HTML source it claims to be generated
// from; a hand-edit to either side (or a forgotten regen after editing the
// HTML) would silently drift with no signal anywhere in the gate. This is
// that enforcement: it re-runs the documented regen command into a scratch
// directory and diffs the result against ../resources/*.rtf byte for byte.
//
// textutil is Apple's own Cocoa text-system CLI — macOS-only, same
// platform-skip law as distribution-xml.test.mjs's `hasAppleTools` checks
// (grepped from that file, which is how the rest of this suite's
// plutil/pkgbuild-dependent tests already skip on the Ubuntu gate leg
// rather than pretending to shim a full HTML->RTF converter — unlike the
// simple `plutil -extract` invocation uninstall-script.test.mjs fakes with
// a one-line shell shim, textutil's actual conversion is not something a
// shim can meaningfully stand in for without just re-implementing it).
//
// Run: node --test installers/macos/pkg/resources-src/rtf-drift.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;
const RESOURCES_DIR = path.join(__dirname, "..", "resources");

const PANES = ["welcome", "readme", "conclusion"];

const hasTextutil = process.platform === "darwin" && spawnSync("which", ["textutil"]).status === 0;

test(
  "committed .rtf panes match a fresh textutil regen of the committed HTML sources (W17 drift check)",
  { skip: hasTextutil ? false : "textutil unavailable on this host (non-macOS — the gate's Ubuntu leg has no Cocoa text system)" },
  () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "loombre-rtf-drift-"));
    try {
      for (const pane of PANES) {
        const htmlPath = path.join(SRC_DIR, `${pane}.html`);
        const outPath = path.join(scratch, `${pane}.rtf`);
        const res = spawnSync("textutil", ["-convert", "rtf", htmlPath, "-output", outPath], { encoding: "utf8" });
        assert.equal(res.status, 0, `textutil -convert rtf ${pane}.html failed:\n${res.stderr}`);

        const fresh = readFileSync(outPath, "utf8");
        const committedPath = path.join(RESOURCES_DIR, `${pane}.rtf`);
        const committed = readFileSync(committedPath, "utf8");
        assert.equal(
          fresh,
          committed,
          `installers/macos/pkg/resources/${pane}.rtf is stale relative to resources-src/${pane}.html — ` +
            `regenerate with \`textutil -convert rtf resources-src/${pane}.html -output resources/${pane}.rtf\` ` +
            "and commit the result (see resources-src/README.txt).",
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
