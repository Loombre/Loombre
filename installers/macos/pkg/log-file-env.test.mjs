#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/log-file-env.test.mjs
//
// LD-11 (this implementation run's lane B3): every install shape
// must set LOOMBRE_LOG_FILE to a platform-appropriate path so
// GET /admin/logs/tail (apps/server/src/catalog/admin-logs-tail.ts) has
// something real to read. On macOS, launchd's own StandardOutPath already
// writes each daemon's stdout to a real file (no tee/shell-redirect
// needed, unlike Linux/Docker where the default supervisor capture isn't
// a file) — this test asserts bin/loombre-server / bin/loombre-worker /
// bin/loombre-web each default LOOMBRE_LOG_FILE to the EXACT SAME path as
// its own launchd plist's StandardOutPath, derived from the real plist
// files rather than a hand-copied parallel list (same house pattern as
// uninstall-script.test.mjs's daemonLabels extraction).
//
// Run: node --test installers/macos/pkg/log-file-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The real `<key>StandardOutPath</key><string>...</string>` value from a
 *  launchd plist — never hand-copied. */
function standardOutPath(plistFile) {
  const xml = readFileSync(path.join(PKG_DIR, "launchd", plistFile), "utf8");
  const m = xml.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(m, `${plistFile} has no StandardOutPath key`);
  return m[1];
}

const SHAPES = [
  { shim: "loombre-server", plist: "com.loombre.server.plist" },
  { shim: "loombre-worker", plist: "com.loombre.worker.plist" },
  { shim: "loombre-web", plist: "com.loombre.web.plist" },
];

for (const { shim, plist } of SHAPES) {
  test(`bin/${shim} defaults LOOMBRE_LOG_FILE to ${plist}'s own StandardOutPath (launchd already writes real content there)`, () => {
    const expected = standardOutPath(plist);
    const source = readFileSync(path.join(PKG_DIR, "bin", shim), "utf8");
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      source,
      new RegExp(`LOOMBRE_LOG_FILE(?::?-?}?)?="?\\$\\{?LOOMBRE_LOG_FILE:-${escaped}}"`),
      `bin/${shim} does not default LOOMBRE_LOG_FILE to ${expected} (StandardOutPath from ${plist})`,
    );
  });
}

test("bin/loombre-server / bin/loombre-worker / bin/loombre-web are syntactically valid sh (`sh -n`)", () => {
  for (const { shim } of SHAPES) {
    const p = path.join(PKG_DIR, "bin", shim);
    for (const shell of ["sh", "bash"]) {
      const res = spawnSync(shell, ["-n", p], { encoding: "utf8" });
      assert.equal(res.status, 0, `${shell} -n bin/${shim} failed:\n${res.stderr}`);
    }
  }
});

test("bin/loombre-server's config/loombre.env override still wins over the LOOMBRE_LOG_FILE default (operator opt-out preserved)", () => {
  // The `${LOOMBRE_LOG_FILE:-default}` idiom (same as every other var this
  // shim sources from config/loombre.env) means an operator-set value in
  // that file, sourced earlier in the script, is never clobbered.
  const source = readFileSync(path.join(PKG_DIR, "bin", "loombre-server"), "utf8");
  const configEnvIdx = source.indexOf("CONFIG_ENV=");
  const logFileIdx = source.indexOf("LOOMBRE_LOG_FILE");
  assert.ok(configEnvIdx >= 0 && logFileIdx >= 0, "expected both CONFIG_ENV sourcing and a LOOMBRE_LOG_FILE default in bin/loombre-server");
  assert.ok(configEnvIdx < logFileIdx, "config/loombre.env must be sourced BEFORE LOOMBRE_LOG_FILE's :- default is applied, or an operator override would never be seen");
});
