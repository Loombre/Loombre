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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
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

test("all five generated wrappers are syntactically valid bash (`bash -n`)", () => {
  const dir = generate();
  try {
    for (const file of ["loombre-server", "loombre-worker", "loombre-web", "loombre", "loombre-ipc-dir-setup"]) {
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

// ── Linux-only environment defaults (PrivateTmp + the desktop tray) ──────
//
// All three systemd units run with PrivateTmp=true, so the worker's
// os.tmpdir()-based transcode staging root was invisible to the server
// (each unit sees its own /tmp): every HLS session sat at "loading"
// forever. The wrappers now default LOOMBRE_TRANSCODE_DIR under the data
// dir — the one path both units may write. Same shape for the controller
// IPC files: under /run/loombre (created setgid to the admin group by the
// server unit's root-run ExecStartPre step, bin/loombre-ipc-dir-setup) so
// the desktop tray, running as the console user, can reach them, with the
// token's group defaulting to the directory's own group.

/** Stub out the final exec so the wrapper prints its environment instead. */
function stubExec(dir, name, entry) {
  const wrapperPath = path.join(dir, "bin", name);
  const source = readFileSync(wrapperPath, "utf8");
  const pattern = new RegExp(`exec "\\$\\{NODE_BIN\\}" "\\$\\{APP_ROOT\\}/${entry.replace(/[./]/g, (c) => `\\${c}`)}" "\\$@"\\n?$`);
  const replaced = source.replace(pattern, 'env | grep -E "^LOOMBRE_(TRANSCODE_DIR|IPC_DIR|IPC_GROUP)=" | sort || true\n');
  assert.notEqual(replaced, source, `could not locate bin/${name}'s final exec line to stub out`);
  writeFileSync(wrapperPath, replaced);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function runStubbed(dir, wrapperPath, env) {
  const res = spawnSync("bash", [wrapperPath], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH, ...env } });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  return Object.fromEntries(
    res.stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

for (const { name, entry } of WRAPPERS) {
  test(`bin/${name}: with LOOMBRE_DATA_DIR set, LOOMBRE_TRANSCODE_DIR defaults to <data dir>/transcode (shared across PrivateTmp units); an explicit value wins; without a data dir nothing is exported`, () => {
    const dir = generate();
    try {
      const wrapperPath = stubExec(dir, name, entry);
      const dataDir = path.join(dir, "data");
      mkdirSync(dataDir, { recursive: true });

      const defaulted = runStubbed(dir, wrapperPath, { LOOMBRE_DATA_DIR: dataDir });
      assert.equal(defaulted.LOOMBRE_TRANSCODE_DIR, path.join(dataDir, "transcode"));

      const explicit = runStubbed(dir, wrapperPath, { LOOMBRE_DATA_DIR: dataDir, LOOMBRE_TRANSCODE_DIR: "/mnt/nvme/loombre-staging" });
      assert.equal(explicit.LOOMBRE_TRANSCODE_DIR, "/mnt/nvme/loombre-staging");

      const bare = runStubbed(dir, wrapperPath, {});
      assert.equal(bare.LOOMBRE_TRANSCODE_DIR, undefined, "no data dir -> the worker's own os.tmpdir() default must stay in force");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("bin/loombre-server: LOOMBRE_IPC_DIR follows systemd's RUNTIME_DIRECTORY (first entry) unless set explicitly; unset with neither", () => {
  const dir = generate();
  try {
    const wrapperPath = stubExec(dir, "loombre-server", "lib/server/dist/main.js");
    const viaRuntimeDir = runStubbed(dir, wrapperPath, { RUNTIME_DIRECTORY: "/run/loombre:/run/loombre-extra" });
    assert.equal(viaRuntimeDir.LOOMBRE_IPC_DIR, "/run/loombre");
    const explicit = runStubbed(dir, wrapperPath, { RUNTIME_DIRECTORY: "/run/loombre", LOOMBRE_IPC_DIR: "/srv/loombre/ipc" });
    assert.equal(explicit.LOOMBRE_IPC_DIR, "/srv/loombre/ipc");
    const neither = runStubbed(dir, wrapperPath, {});
    assert.equal(neither.LOOMBRE_IPC_DIR, undefined, "without RuntimeDirectory the server's own default (the data dir) must stay in force");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The admin group bin/loombre-ipc-dir-setup picks on THIS host: the
 *  first of wheel / sudo / admin that exists (undefined when none does). */
function firstAdminGroupOnHost() {
  const groups = new Set(
    readFileSync("/etc/group", "utf8")
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.split(":")[0]),
  );
  return ["wheel", "sudo", "admin"].find((g) => groups.has(g));
}

function groupNameOf(path) {
  const gnu = spawnSync("stat", ["-c", "%G", path], { encoding: "utf8" });
  if (gnu.status === 0) return gnu.stdout.trim();
  const bsd = spawnSync("stat", ["-f", "%Sg", path], { encoding: "utf8" });
  return bsd.status === 0 ? bsd.stdout.trim() : "";
}

test("bin/loombre-server: LOOMBRE_IPC_GROUP defaults to the RUNTIME_DIRECTORY's own group (whatever bin/loombre-ipc-dir-setup made it — the server's chown is then a no-op it is allowed to make); an explicit value wins; unset without a runtime dir", () => {
  const dir = generate();
  try {
    const wrapperPath = stubExec(dir, "loombre-server", "lib/server/dist/main.js");
    const runtimeDir = path.join(dir, "run-loombre");
    mkdirSync(runtimeDir);
    const defaulted = runStubbed(dir, wrapperPath, { RUNTIME_DIRECTORY: runtimeDir });
    assert.equal(defaulted.LOOMBRE_IPC_GROUP, groupNameOf(runtimeDir));
    assert.ok(defaulted.LOOMBRE_IPC_GROUP.length > 0);
    const explicit = runStubbed(dir, wrapperPath, { RUNTIME_DIRECTORY: runtimeDir, LOOMBRE_IPC_GROUP: "loombre-admins" });
    assert.equal(explicit.LOOMBRE_IPC_GROUP, "loombre-admins");
    const none = runStubbed(dir, wrapperPath, {});
    assert.equal(none.LOOMBRE_IPC_GROUP, undefined, "without a runtime dir the server keeps its own default (its primary group)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin/loombre-ipc-dir-setup: makes the runtime dir setgid (2750) to the first existing admin group, honours LOOMBRE_IPC_GROUP, ignores a missing dir, and never fails the unit", { skip: !existsSync("/etc/group") && "no /etc/group on this host" }, () => {
  const dir = generate();
  try {
    const setupPath = path.join(dir, "bin", "loombre-ipc-dir-setup");
    assert.ok(existsSync(setupPath), "bin/loombre-ipc-dir-setup is missing from the generated wrappers");
    const env = { PATH: process.env.PATH };

    // 1. Default: the host's admin group. chgrp only works for a group the
    //    test user belongs to, so assert on whatever chgrp achieved and on
    //    the mode, and require the group when the user is a member.
    const adminGroup = firstAdminGroupOnHost();
    const runtimeDir = path.join(dir, "run-loombre");
    mkdirSync(runtimeDir, { mode: 0o755 });
    const res = spawnSync("bash", [setupPath], { encoding: "utf8", env: { ...env, RUNTIME_DIRECTORY: `${runtimeDir}:/nonexistent-second` } });
    assert.equal(res.status, 0, `setup must exit 0 (stderr: ${res.stderr})`);
    const myGroups = spawnSync("id", ["-Gn"], { encoding: "utf8" }).stdout.trim().split(/\s+/);
    if (adminGroup && myGroups.includes(adminGroup)) {
      assert.equal(groupNameOf(runtimeDir), adminGroup, `runtime dir should be group ${adminGroup}`);
      assert.equal(statSync(runtimeDir).mode & 0o7777, 0o2750, "runtime dir must be setgid 2750 so the server's files inherit the group");
    }

    // 2. Explicit LOOMBRE_IPC_GROUP wins (a group the test user is in, so chgrp can succeed anywhere).
    const primary = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
    const explicitDir = path.join(dir, "run-explicit");
    mkdirSync(explicitDir, { mode: 0o755 });
    const res2 = spawnSync("bash", [setupPath, explicitDir], { encoding: "utf8", env: { ...env, LOOMBRE_IPC_GROUP: primary } });
    assert.equal(res2.status, 0, res2.stderr);
    assert.equal(groupNameOf(explicitDir), primary);
    assert.equal(statSync(explicitDir).mode & 0o7777, 0o2750);

    // 3. An unknown group: no chgrp, the directory falls back to owner-only
    //    (0750, no setgid), still exit 0 — a typo in the env file must not
    //    wedge the server unit, and must not leave the token world-listable.
    const untouchedDir = path.join(dir, "run-untouched");
    mkdirSync(untouchedDir, { mode: 0o755 });
    const before = groupNameOf(untouchedDir);
    const res3 = spawnSync("bash", [setupPath, untouchedDir], { encoding: "utf8", env: { ...env, LOOMBRE_IPC_GROUP: "no-such-group-loombre-test" } });
    assert.equal(res3.status, 0, res3.stderr);
    assert.equal(groupNameOf(untouchedDir), before);
    assert.equal(statSync(untouchedDir).mode & 0o7777, 0o750);

    // 4. No directory argument and no RUNTIME_DIRECTORY: exit 0, nothing to do.
    const res4 = spawnSync("bash", [setupPath], { encoding: "utf8", env });
    assert.equal(res4.status, 0, res4.stderr);

    // 5. A missing directory is CREATED (the unit no longer uses
    //    RuntimeDirectory=, so this step owns /run/loombre outright) and
    //    made setgid to the explicit group.
    const created = path.join(dir, "run-created");
    const res5 = spawnSync("bash", [setupPath, created], { encoding: "utf8", env: { ...env, LOOMBRE_IPC_GROUP: primary } });
    assert.equal(res5.status, 0, res5.stderr);
    assert.ok(existsSync(created), "the setup step must create the directory");
    assert.equal(groupNameOf(created), primary);
    assert.equal(statSync(created).mode & 0o7777, 0o2750);

    // 6. --remove deletes it (the unit's ExecStopPost); a missing dir and "/" are ignored.
    writeFileSync(path.join(created, "controller-ipc.token"), "tok");
    const res6 = spawnSync("bash", [setupPath, "--remove", created], { encoding: "utf8", env });
    assert.equal(res6.status, 0, res6.stderr);
    assert.ok(!existsSync(created), "--remove must delete the directory and its files");
    assert.equal(spawnSync("bash", [setupPath, "--remove", path.join(dir, "never-existed")], { encoding: "utf8", env }).status, 0);
    assert.equal(spawnSync("bash", [setupPath, "--remove", "/"], { encoding: "utf8", env }).status, 0);
    assert.ok(existsSync("/etc"), "--remove / must be a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all three service wrappers disable ANSI colour (NO_COLOR=1, FORCE_COLOR=0) — their stdout is a log tee and the journal, never a terminal", () => {
  const dir = generate();
  try {
    for (const { name } of WRAPPERS) {
      const source = readFileSync(path.join(dir, "bin", name), "utf8");
      assert.match(source, /^export NO_COLOR=1$/m, `bin/${name} must export NO_COLOR=1`);
      assert.match(source, /^export FORCE_COLOR=0$/m, `bin/${name} must export FORCE_COLOR=0`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin/loombre-worker and bin/loombre-web never set the IPC variables (only the server writes the discovery files)", () => {
  const dir = generate();
  try {
    for (const name of ["loombre-worker", "loombre-web"]) {
      const source = readFileSync(path.join(dir, "bin", name), "utf8");
      assert.ok(!source.includes("LOOMBRE_IPC_"), `bin/${name} unexpectedly references LOOMBRE_IPC_*`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
