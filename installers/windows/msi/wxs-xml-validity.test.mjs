// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/msi/wxs-xml-validity.test.mjs
//
// Guards the WIX0104 class: an XML comment may not contain the two-hyphen
// sequence "--", and "-" may not be its last character (XML 1.0 §2.5 —
// `wix build` enforces this and dies). This escaped to the v0.9.0-rc.4
// RELEASE run (31135522804): audit-wave comments in Services.wxs and
// Firewall.wxs mentioned `next start`'s "--hostname"/"--port" flags
// verbatim, every local gate stayed green (nothing on a non-Windows host
// parses these files as XML), and the first real XML parser they met was
// the WiX compiler on windows-latest — inside the release pipeline.
//
// Deliberately a targeted comment-body scan, not full XML well-formedness:
// Node has no built-in XML parser, the repo's no-new-deps posture makes a
// parser dependency disproportionate for this, and full well-formedness IS
// checked where it can be — by `wix build` itself in windows-installer-diag
// (auto-runs on installers/** pushes) and the release leg. This test's job
// is to catch the one class that is (a) trivially greppable, (b) proven to
// reach a release run, and (c) invisible to every non-Windows check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MSI_DIR = path.dirname(fileURLToPath(import.meta.url));

const xmlSources = readdirSync(MSI_DIR).filter(
  (f) => f.endsWith(".wxs") || f.endsWith(".wxi"),
);

test("every .wxs/.wxi XML comment is WIX0104-clean (no '--', no trailing '-')", () => {
  assert.ok(xmlSources.length > 0, `no .wxs/.wxi files found in ${MSI_DIR}`);
  const violations = [];
  for (const file of xmlSources) {
    const src = readFileSync(path.join(MSI_DIR, file), "utf8");
    // XML comments cannot nest, so a non-greedy scan is exact.
    for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
      const body = m[1];
      const line = src.slice(0, m.index).split("\n").length;
      if (body.endsWith("-")) {
        violations.push(`${file}:${line}: comment body ends with '-'`);
      }
      const rel = body.indexOf("--");
      if (rel !== -1) {
        const innerLine = line + body.slice(0, rel).split("\n").length - 1;
        const snippet = body.split("\n")[body.slice(0, rel).split("\n").length - 1].trim().slice(0, 80);
        violations.push(`${file}:${innerLine}: '--' inside XML comment: ${snippet}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `WIX0104: these comments will kill \`wix build\` on the release runner:\n${violations.join("\n")}`,
  );
});
