#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/wrapper-scripts.test.mjs
//
// LD-11 (this implementation run's lane B3): every install shape
// must set LOOMBRE_LOG_FILE to a platform-appropriate path so
// GET /admin/logs/tail (apps/server/src/catalog/admin-logs-tail.ts) has
// something real to read. On Linux, systemd's default StandardOutput is
// the journal (the extensively documented troubleshooting path — see
// docs/ops/systemd.md, docs/install/linux.md, docs/install/
// troubleshooting.md), not a file, so build-tarball.mjs's generated
// bin/loombre-server / bin/loombre-worker / bin/loombre-web shims now tee
// their own stdout+stderr to a real file under $LOOMBRE_DATA_DIR/logs
// (preserving journal capture unchanged) before `exec`-ing into node —
// see writeWrapperScripts's own logRedirectBlock comment for the full
// tini/systemd-signal-safety rationale (same shape as docker-compose.
// prod.yml's tee override, verified against a real tini+bash+node
// container in this lane's exit report).
//
// This imports writeWrapperScripts directly (exported for exactly this —
// "rendered + bash -n-checked without running a full tarball assembly",
// per its own header) rather than running a full `assembleTarball`, so it
// needs no fetched Node/ffmpeg/PG payloads and stays fast.
//
// Run: node --test installers/linux/wrapper-scripts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeWrapperScripts } from "./build-tarball.mjs";

function generate() {
  const dir = mkdtempSync(path.join(tmpdir(), "loombre-wrapper-scripts-test-"));
  writeWrapperScripts(dir);
  return dir;
}

const WRAPPERS = [
  { name: "loombre-server", logName: "server.log", entry: "lib/server/dist/main.js" },
  { name: "loombre-worker", logName: "worker.log", entry: "lib/worker/dist/index.js" },
  { name: "loombre-web", logName: "web.log", entry: "web/apps/web/server.js" },
];

for (const { name, logName } of WRAPPERS) {
  test(`bin/${name}: defaults LOOMBRE_LOG_FILE to logs/${logName} (relative — resolves under LOOMBRE_DATA_DIR via the common block's own cd)`, () => {
    const dir = generate();
    try {
      const source = readFileSync(path.join(dir, "bin", name), "utf8");
      assert.match(
        source,
        new RegExp(`: "\\\$\\{LOOMBRE_LOG_FILE:=logs/${logName.replace(".", "\\.")}\\}"`),
        `bin/${name} does not default LOOMBRE_LOG_FILE to logs/${logName}`,
      );
      assert.match(source, /export LOOMBRE_LOG_FILE\b/, `bin/${name} never exports LOOMBRE_LOG_FILE — a child process would not see it`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`bin/${name}: tees to LOOMBRE_LOG_FILE, then execs node LAST (systemd/tini-signal-safe — node must become the tracked pid, not a wrapping shell)`, () => {
    const dir = generate();
    try {
      const source = readFileSync(path.join(dir, "bin", name), "utf8");
      const teeIdx = source.indexOf('exec > >(tee -a "${LOOMBRE_LOG_FILE}") 2>&1');
      assert.ok(teeIdx >= 0, `bin/${name} does not tee stdout+stderr to LOOMBRE_LOG_FILE`);
      const finalExecMatch = source.match(/exec "\$\{NODE_BIN\}"[^\n]*\n?$/);
      assert.ok(finalExecMatch, `bin/${name}'s last line is not an exec of NODE_BIN`);
      assert.ok(
        finalExecMatch.index > teeIdx,
        `bin/${name}: the tee redirect must run BEFORE the final exec node (found at ${teeIdx}, exec at ${finalExecMatch.index})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("bin/loombre (the CLI shim) does NOT tee to a log file — it is a one-shot invocation, not a long-running service", () => {
  const dir = generate();
  try {
    const source = readFileSync(path.join(dir, "bin", "loombre"), "utf8");
    assert.ok(!source.includes("LOOMBRE_LOG_FILE"), "bin/loombre unexpectedly references LOOMBRE_LOG_FILE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all four generated wrappers are syntactically valid bash (`bash -n`)", () => {
  const dir = generate();
  try {
    for (const file of ["loombre-server", "loombre-worker", "loombre-web", "loombre"]) {
      const res = spawnSync("bash", ["-n", path.join(dir, "bin", file)], { encoding: "utf8" });
      assert.equal(res.status, 0, `bash -n bin/${file} failed:\n${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("behavioral: running bin/loombre-server (NODE_BIN stubbed out) writes IDENTICAL content to stdout AND the log file, creates the logs/ dir, and exits 0", () => {
  const dir = generate();
  try {
    const serverPath = path.join(dir, "bin", "loombre-server");
    let source = readFileSync(serverPath, "utf8");
    // Replace the final `exec "${NODE_BIN}" ... "$@"` line with a tiny
    // stub that proves the env var reached a "child" and that stdout
    // still flows (the whole point of tee over a plain `>` redirect).
    const replaced = source.replace(
      /exec "\$\{NODE_BIN\}" "\$\{APP_ROOT\}\/lib\/server\/dist\/main\.js" "\$@"\n?$/,
      'echo "stub running, LOOMBRE_LOG_FILE=$LOOMBRE_LOG_FILE"\n',
    );
    assert.notEqual(replaced, source, "could not locate the final exec line to stub out — has writeWrapperScripts changed shape?");
    writeFileSync(serverPath, replaced);
    chmodSync(serverPath, 0o755);

    const res = spawnSync("bash", [serverPath], { encoding: "utf8", cwd: dir });
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    assert.match(res.stdout, /^stub running, LOOMBRE_LOG_FILE=logs\/server\.log$/m);

    const logPath = path.join(dir, "logs", "server.log");
    assert.ok(existsSync(logPath), "logs/server.log was never created");
    const logContent = readFileSync(logPath, "utf8");
    assert.equal(logContent.trim(), res.stdout.trim(), "the tee'd file content must match stdout exactly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
