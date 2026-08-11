#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/uninstall-script.test.mjs
//
// macOS has no built-in `.pkg` uninstaller. A real rc.6 uninstall audit
// found operators doing the manual removal from docs/install/macos.md's
// old "Uninstalling" block and landing in a PARTIAL state — daemon plists
// + /opt/loombre left behind, so the stack resurrected on the next boot —
// because that block was easy to abandon halfway through (many separate
// `sudo` commands, no single idempotent entry point, no `pkgutil
// --forget`, and a `dscl . -delete` line for the service account that
// simply fails outright on macOS 26 with no fallback).
// pkg/bin/uninstall.sh is the fix: one script, shipped IN the payload at
// /opt/loombre/current/bin/uninstall.sh, that cleans up whatever subset of
// {launchd jobs, plists, /opt/loombre, the app, the account} actually
// exists without dying partway through.
//
// This test derives its expectations (which launchd labels, which plist
// paths, which receipt id) from the SAME source files the real payload is
// built from — never a hand-maintained parallel list — so if a future
// daemon/agent is added to pkg/launchd//pkg/launchagents/postinstall
// without updating uninstall.sh to match, this test fails instead of
// silently shipping an uninstaller that leaves the new job running.
//
// Run: node --test installers/macos/pkg/uninstall-script.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BIN_PAYLOAD_SCRIPTS } from "../build-pkg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = __dirname;
const SCRIPT_PATH = path.join(PKG_DIR, "bin", "uninstall.sh");
const POSTINSTALL_PATH = path.join(PKG_DIR, "scripts", "postinstall");
const BUILD_PKG_PATH = path.join(PKG_DIR, "..", "build-pkg.mjs");

const scriptSource = readFileSync(SCRIPT_PATH, "utf8");

// ---------------------------------------------------------------------
// Source-of-truth extraction — read the REAL plist files + the REAL
// postinstall script, never a hand-copied list.
// ---------------------------------------------------------------------

/** Every `<key>Label</key><string>...</string>` in a plist file's raw XML. */
function extractLabels(plistXml) {
  return [...plistXml.matchAll(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

function readLabelsFromDir(dir) {
  const labels = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".plist")) continue;
    labels.push(...extractLabels(readFileSync(path.join(dir, file), "utf8")));
  }
  return labels;
}

const daemonLabels = readLabelsFromDir(path.join(PKG_DIR, "launchd")); // system domain
const agentLabels = readLabelsFromDir(path.join(PKG_DIR, "launchagents")); // gui/<uid> domain

test("sanity: this repo currently ships exactly 3 LaunchDaemons + 1 LaunchAgent (4 launchd jobs total, per the audit)", () => {
  assert.equal(daemonLabels.length, 3, `expected 3 LaunchDaemon labels, found ${JSON.stringify(daemonLabels)}`);
  assert.equal(agentLabels.length, 1, `expected 1 LaunchAgent label, found ${JSON.stringify(agentLabels)}`);
});

// The exact `/Library/LaunchDaemons/<file>.plist` paths postinstall itself
// bootstraps — reusing postinstall's OWN list (rather than re-deriving
// from readdirSync + a guessed directory) means this test fails if
// postinstall and uninstall.sh ever disagree about which plists exist,
// which is the actual failure mode the audit is worried about.
const postinstallSource = readFileSync(POSTINSTALL_PATH, "utf8");
const daemonPlistPaths = [
  ...postinstallSource.matchAll(/\/Library\/LaunchDaemons\/com\.loombre\.[a-zA-Z]+\.plist/g),
].map((m) => m[0]);
const uniqueDaemonPlistPaths = [...new Set(daemonPlistPaths)];

test("sanity: postinstall's own bootstrap loop names all 3 LaunchDaemon plist paths", () => {
  assert.equal(uniqueDaemonPlistPaths.length, 3, JSON.stringify(uniqueDaemonPlistPaths));
});

const buildPkgSource = readFileSync(BUILD_PKG_PATH, "utf8");
const receiptIdMatch = buildPkgSource.match(/"--identifier",\s*"([^"]+)"/);
assert.ok(receiptIdMatch, "could not find pkgbuild --identifier in build-pkg.mjs — has the arg shape changed?");
const RECEIPT_ID = receiptIdMatch[1];

// ---------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------

test("uninstall.sh ships executable at pkg/bin/uninstall.sh", () => {
  assert.ok(existsSync(SCRIPT_PATH), `missing ${SCRIPT_PATH}`);
  const mode = statSync(SCRIPT_PATH).mode;
  assert.ok(mode & 0o111, "uninstall.sh is not executable (chmod 755 it, same as every other pkg/bin shim)");
});

test("build-pkg.mjs's BIN_PAYLOAD_SCRIPTS (the payload staging list) includes uninstall.sh", () => {
  assert.ok(
    BIN_PAYLOAD_SCRIPTS.includes("uninstall.sh"),
    `BIN_PAYLOAD_SCRIPTS is ${JSON.stringify(BIN_PAYLOAD_SCRIPTS)} — assemblePayload() will not stage uninstall.sh into ` +
      "<versionDir>/bin/ unless it is a member of this list",
  );
  // Every listed script must actually exist in pkg/bin/ — proves the
  // staging list and the real files never drift apart. NOT an exec-bit
  // check here: pkg/bin/*'s checked-in git mode is 100644 by existing
  // convention (unlike pkg/scripts/{pre,post}install, which ship 100755) —
  // assemblePayload()'s own chmodSync(..., 0o755) is what makes the
  // STAGED copy executable regardless of the source file's mode on disk
  // (see build-pkg.mjs's payload bin/ loop). uninstall.sh's own exec bit
  // is asserted separately below, since it (like the shell it's written
  // in) benefits from being runnable straight out of this checkout too.
  for (const shim of BIN_PAYLOAD_SCRIPTS) {
    const p = path.join(PKG_DIR, "bin", shim);
    assert.ok(existsSync(p), `BIN_PAYLOAD_SCRIPTS lists "${shim}" but ${p} does not exist`);
  }
});

test("bash -n / sh -n: uninstall.sh is syntactically valid POSIX sh", () => {
  for (const shell of ["bash", "sh"]) {
    const res = spawnSync(shell, ["-n", SCRIPT_PATH], { encoding: "utf8" });
    assert.equal(res.status, 0, `${shell} -n failed:\n${res.stderr}`);
  }
});

test("uninstall.sh's launchd bootout covers every LaunchDaemon label the payload actually ships (derived from pkg/launchd/*.plist)", () => {
  assert.ok(daemonLabels.length > 0, "no daemon labels extracted — did pkg/launchd/*.plist move or change shape?");
  for (const label of daemonLabels) {
    const pattern = new RegExp(`system/${label.replace(/\./g, "\\.")}\\b`);
    assert.match(
      scriptSource,
      pattern,
      `uninstall.sh never references "system/${label}" — a real LaunchDaemon the payload ships would survive uninstall`,
    );
  }
});

test("uninstall.sh's launchd bootout covers every LaunchAgent label the payload actually ships (derived from pkg/launchagents/*.plist)", () => {
  assert.ok(agentLabels.length > 0, "no agent labels extracted — did pkg/launchagents/*.plist move or change shape?");
  for (const label of agentLabels) {
    // Agents run in the CONSOLE user's gui/<uid> domain, built from a
    // shell variable — assert the gui/ construction and the label appear
    // together (not a literal "gui/$UID/label" string, since UID is
    // resolved at runtime).
    assert.match(scriptSource, /gui\/\$\{?CONSOLE_UID\}?/, "uninstall.sh never resolves a gui/<uid> domain for the agent");
    const labelPattern = new RegExp(label.replace(/\./g, "\\."));
    assert.match(scriptSource, labelPattern, `uninstall.sh never references agent label "${label}"`);
  }
});

test("uninstall.sh removes every LaunchDaemon plist path postinstall itself bootstraps", () => {
  for (const plistPath of uniqueDaemonPlistPaths) {
    assert.ok(
      scriptSource.includes(plistPath),
      `uninstall.sh never references ${plistPath} (postinstall bootstraps it, so uninstall.sh must remove it)`,
    );
  }
});

test("uninstall.sh removes the LaunchAgent plist path", () => {
  assert.match(scriptSource, /\/Library\/LaunchAgents\/com\.loombre\.menubar\.plist/);
});

test("uninstall.sh forgets the real pkgutil receipt id from build-pkg.mjs's own pkgbuild --identifier", () => {
  assert.match(scriptSource, /pkgutil\s+--forget/, "uninstall.sh never calls pkgutil --forget");
  assert.ok(
    scriptSource.includes(RECEIPT_ID),
    `uninstall.sh never references receipt id "${RECEIPT_ID}" (from build-pkg.mjs's pkgbuild --identifier)`,
  );
});

test("uninstall.sh removes /opt/loombre, /Applications/Loombre.app, and the log directory (all three from postinstall's own path constants)", () => {
  const optDirMatch = postinstallSource.match(/OPT_DIR="([^"]+)"/);
  const logDirMatch = postinstallSource.match(/LOG_DIR="([^"]+)"/);
  assert.ok(optDirMatch && logDirMatch, "postinstall no longer defines OPT_DIR/LOG_DIR as expected — update the extraction above");
  assert.ok(scriptSource.includes(optDirMatch[1]), `uninstall.sh never references ${optDirMatch[1]}`);
  assert.ok(scriptSource.includes(logDirMatch[1]), `uninstall.sh never references ${logDirMatch[1]}`);
  // /Applications/Loombre.app: derived from build-pkg.mjs's own
  // assembleAppBundle() path.join segments, not hardcoded here.
  assert.match(buildPkgSource, /"Applications",\s*"Loombre\.app"/, "build-pkg.mjs no longer assembles Applications/Loombre.app at that path");
  assert.match(scriptSource, /\/Applications\/Loombre\.app/);
});

test("uninstall.sh documents the app-data path and defaults to KEEPING it (mirrors installers/linux/uninstall.sh's --purge posture)", () => {
  assert.match(scriptSource, /Library\/Application Support\/Loombre/);
  assert.match(scriptSource, /--purge/);
  // Linux's own flag name, reused verbatim per the lane brief.
  const linuxUninstallSource = readFileSync(path.join(PKG_DIR, "..", "..", "linux", "uninstall.sh"), "utf8");
  assert.match(linuxUninstallSource, /--purge/, "installers/linux/uninstall.sh no longer uses --purge — reconcile the flag name");
});

test("uninstall.sh's service-account deletion uses sysadminctl -deleteUser (interactive by default), not a bare dscl delete", () => {
  assert.match(scriptSource, /sysadminctl\s+-deleteUser\s+_loombre\s+interactive/);
  assert.match(scriptSource, /--adminUser/);
  assert.match(scriptSource, /--adminPassword/);
  assert.match(scriptSource, /-adminUser/); // the sysadminctl flag itself, passed through
  assert.match(scriptSource, /-adminPassword/);
  // Documents the macOS 26 permission-wall finding and the /var/empty note
  // from the lane brief, so an operator reading the output understands
  // WHY this differs from the old docs' `dscl . -delete` line.
  assert.match(scriptSource, /eDSPermissionError/i);
  assert.match(scriptSource, /var\/empty/);
});

test("uninstall.sh supports --dry-run (testable without root/sudo)", () => {
  assert.match(scriptSource, /--dry-run/);
});

test("uninstall.sh does NOT globally `set -e` (idempotent/partial-state tolerant — see its own header)", () => {
  assert.ok(!/^set -e/m.test(scriptSource), "a global `set -e` would abort on the first already-absent item during a partial-state uninstall");
});

// ---------------------------------------------------------------------
// Behavioral checks — actually run the shipped script.
// ---------------------------------------------------------------------

test("--dry-run: exits 0, requires no root, and mentions every label/path/flag surface without touching the filesystem", () => {
  const res = spawnSync(SCRIPT_PATH, ["--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  for (const label of daemonLabels) {
    assert.match(res.stdout, new RegExp(`system/${label.replace(/\./g, "\\.")}`));
  }
  for (const label of agentLabels) {
    assert.match(res.stdout, new RegExp(label.replace(/\./g, "\\.")));
  }
  for (const plistPath of uniqueDaemonPlistPaths) {
    assert.ok(res.stdout.includes(plistPath), `dry-run output missing ${plistPath}`);
  }
  assert.ok(res.stdout.includes(RECEIPT_ID));
  assert.match(res.stdout, /\/opt\/loombre/);
  assert.match(res.stdout, /\/Applications\/Loombre\.app/);
  assert.match(res.stdout, /Library\/Logs\/Loombre/);
  assert.match(res.stdout, /sysadminctl/);
});

test("--dry-run --purge: plans to remove app data; without --purge, plans to keep it", () => {
  const withPurge = spawnSync(SCRIPT_PATH, ["--dry-run", "--purge"], { encoding: "utf8" });
  assert.equal(withPurge.status, 0);
  assert.match(withPurge.stdout, /Application Support\/Loombre.*\n.*would run: rm -rf/s);

  const withoutPurge = spawnSync(SCRIPT_PATH, ["--dry-run"], { encoding: "utf8" });
  assert.equal(withoutPurge.status, 0);
  assert.match(withoutPurge.stdout, /app data preserved/i);
  assert.ok(!/would run: rm -rf "\/Library\/Application Support\/Loombre"/.test(withoutPurge.stdout));
});

test("--dry-run --adminUser X --adminPassword Y: plans the scripted sysadminctl form instead of the interactive one", () => {
  const res = spawnSync(SCRIPT_PATH, ["--dry-run", "--adminUser", "opuser", "--adminPassword", "hunter2"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /-adminUser opuser/);
  assert.ok(!res.stdout.includes("hunter2"), "the password must never be echoed verbatim into output");
});

test("--help exits 0 and documents --purge/--dry-run/--adminUser/--adminPassword", () => {
  const res = spawnSync(SCRIPT_PATH, ["--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  for (const flag of ["--purge", "--dry-run", "--adminUser", "--adminPassword"]) {
    assert.ok(res.stdout.includes(flag), `--help output missing ${flag}`);
  }
});

test("unrecognized flag: exits nonzero with usage on stderr", () => {
  const res = spawnSync(SCRIPT_PATH, ["--totally-bogus-flag"], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unrecognized argument/);
});

test("--adminUser as the LAST argv element (no value follows): exits 1 with a clear message, never hangs", () => {
  // THE MAJOR argv-parsing finding: the original `--adminUser) ADMIN_USER="$2"; shift 2 ;;`
  // reads $2 (unset) and then `shift 2` fails WITHOUT shifting anything
  // when only one argv element remains — so `while [ $# -gt 0 ]` never
  // makes progress and spins forever at 100% CPU (this script runs as
  // root). `timeout` turns a real hang into a definitive test failure
  // (null status / SIGTERM) instead of hanging the test run itself.
  const res = spawnSync(SCRIPT_PATH, ["--dry-run", "--adminUser"], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(res.signal, "SIGTERM", `script hung past the 5s test timeout and was killed — this IS the infinite-loop bug (stdout so far:\n${res.stdout})`);
  assert.equal(res.status, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /--adminUser requires a value/);
});

test("--adminPassword as the LAST argv element (no value follows): exits 1 with a clear message, never hangs", () => {
  const res = spawnSync(SCRIPT_PATH, ["--dry-run", "--adminPassword"], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(res.signal, "SIGTERM", `script hung past the 5s test timeout and was killed — this IS the infinite-loop bug (stdout so far:\n${res.stdout})`);
  assert.equal(res.status, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /--adminPassword requires a value/);
});

test(
  "without --dry-run and without root: refuses with a clear error (skipped if this test process itself runs as root)",
  { skip: process.getuid && process.getuid() === 0 ? "test process is running as root" : false },
  () => {
    const res = spawnSync(SCRIPT_PATH, [], { encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must run as root/);
  },
);

test("--dry-run is idempotent / partial-state tolerant against a scratch HOME with no real Loombre install present (never throws, always exits 0)", () => {
  // Runs in a scratch cwd/env with nothing Loombre-related present, proving
  // the script's existence checks (not blind deletes) are what make a
  // partial/absent install a non-error — the exact audit finding (a
  // partial manual uninstall must not leave the script unable to finish).
  const scratch = mkdtempSync(path.join(tmpdir(), "loombre-uninstall-dryrun-"));
  try {
    const res = spawnSync(SCRIPT_PATH, ["--dry-run"], { encoding: "utf8", cwd: scratch });
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Fix-lane review findings — receipt-forget ordering, relocated-bundle
// detection, and CONSOLE_UID validation.
// ---------------------------------------------------------------------

test("uninstall.sh forgets the pkgutil receipt LAST — after /opt/loombre removal, not before payload removal", () => {
  // MINOR finding: an interrupted run (the interactive sysadminctl GUI
  // prompt is a natural abandon point) must not have already forgotten the
  // receipt before the files it could otherwise be used to enumerate are
  // actually gone.
  const res = spawnSync(SCRIPT_PATH, ["--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const optIdx = res.stdout.indexOf("would run: rm -rf /opt/loombre");
  const forgetIdx = res.stdout.indexOf(`pkgutil --forget ${RECEIPT_ID}`);
  assert.ok(optIdx >= 0, `could not find the /opt/loombre removal marker in dry-run output:\n${res.stdout}`);
  assert.ok(forgetIdx >= 0, `could not find the pkgutil --forget marker in dry-run output:\n${res.stdout}`);
  assert.ok(
    forgetIdx > optIdx,
    "pkgutil --forget must run AFTER /opt/loombre removal (forgetting the receipt too early is a real audit finding)",
  );
});

test("CONSOLE_UID: PATH-shimmed `stat` emitting non-numeric/multi-line output (simulating GNU stat's `-f` = --file-system) falls back to uid 0 cleanly", () => {
  const shimDir = mkdtempSync(path.join(tmpdir(), "loombre-uninstall-stat-shim-"));
  try {
    const fakeStat = '#!/bin/sh\necho "  File: \\"/dev\\""\necho "ID: deadbeefcafe Namelen: 255     Type: apfs"\n';
    writeFileSync(path.join(shimDir, "stat"), fakeStat);
    chmodSync(path.join(shimDir, "stat"), 0o755);
    const res = spawnSync(SCRIPT_PATH, ["--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    assert.match(res.stdout, /console uid 0/i, `expected a numeric-coerced uid 0, got:\n${res.stdout}`);
    assert.match(res.stdout, /no console user/i);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});

/** Prepends a fake `pkgutil` to PATH that answers `--pkg-info-plist` with a
 * synthetic receipt (volume + install-location only), runs `fn(shimDir)`,
 * and cleans up. Lets the stray-bundle tests below exercise the receipt
 * lookup without an actual installed pkg receipt (this dev/CI machine has
 * none — see the "no pkgutil receipt present" test). */
function withFakePkgutilReceipt(volume, installLocation, fn) {
  const shimDir = mkdtempSync(path.join(tmpdir(), "loombre-uninstall-pkgutil-shim-"));
  try {
    const fakePkgutil = `#!/bin/sh
if [ "$1" = "--pkg-info-plist" ]; then
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>volume</key>
  <string>${volume}</string>
  <key>install-location</key>
  <string>${installLocation}</string>
</dict>
</plist>
PLIST
  exit 0
fi
exit 1
`;
    writeFileSync(path.join(shimDir, "pkgutil"), fakePkgutil);
    chmodSync(path.join(shimDir, "pkgutil"), 0o755);
    // plutil is macOS-only, but the gate's installers-test step also runs
    // these behaviorally on the ubuntu leg (caught live: rc.7 CI red while
    // the same tests passed on the macOS dev machine). Shim the one
    // invocation shape uninstall.sh uses — `plutil -extract <key> raw -o - -`
    // — against the fixed plist shape this harness itself generates, so the
    // whole receipt pipeline is hermetic on both OSes.
    const fakePlutil = `#!/bin/sh
key="$2"
sed -n "/<key>$key<\\/key>/{n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}"
exit 0
`;
    writeFileSync(path.join(shimDir, "plutil"), fakePlutil);
    chmodSync(path.join(shimDir, "plutil"), 0o755);
    return fn(shimDir);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
}

test("stray relocated app bundle: no pkgutil receipt present on this machine — prints a note and skips, never guesses", () => {
  // This dev/CI machine has no real `com.loombre.pkg` receipt registered
  // (verified independently via `pkgutil --pkg-info-plist com.loombre.pkg`
  // — "No receipt ... found"), so this exercises the real, unshimmed
  // no-receipt path end to end.
  const res = spawnSync(SCRIPT_PATH, ["--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no pkgutil receipt for com\.loombre\.pkg.*skipping relocated-bundle check/i);
});

test("stray relocated app bundle: receipt recording a non-standard volume plans removal of that copy too (dry-run)", () => {
  // MINOR finding: rc.6-and-earlier installs (commit 3ce5edca) could
  // relocate the bundle away from /Applications; a receipt recording a
  // different volume/install-location must be picked up and (in dry-run)
  // planned for removal, guarded by the [dry-run] would-run-line invariant.
  const scratch = mkdtempSync(path.join(tmpdir(), "loombre-uninstall-stray-"));
  try {
    const appContents = path.join(scratch, "Applications", "Loombre.app", "Contents");
    mkdirSync(appContents, { recursive: true });
    withFakePkgutilReceipt(scratch, "/", (shimDir) => {
      const res = spawnSync(SCRIPT_PATH, ["--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      });
      assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
      const expectedPath = path.join(scratch, "Applications", "Loombre.app");
      assert.ok(res.stdout.includes(expectedPath), `dry-run output missing relocated bundle path ${expectedPath}:\n${res.stdout}`);
      const escaped = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(res.stdout, new RegExp(`\\[dry-run\\] would run: rm -rf "${escaped}"`));
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("stray relocated app bundle: receipt pointing at a path with no real Contents/ (not an actual bundle) is skipped, not flagged", () => {
  // Validation gate: absolute + ends in /Loombre.app + not "/" + a real
  // Contents/ subdirectory. Deliberately do NOT create the bundle under
  // scratch, so the derived path must fail validation and be skipped.
  const scratch = mkdtempSync(path.join(tmpdir(), "loombre-uninstall-stray-novalid-"));
  try {
    withFakePkgutilReceipt(scratch, "/", (shimDir) => {
      const res = spawnSync(SCRIPT_PATH, ["--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      });
      assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
      const wouldBePath = path.join(scratch, "Applications", "Loombre.app");
      assert.ok(
        !res.stdout.includes(`rm -rf "${wouldBePath}"`),
        `should not have planned removal of a non-bundle path ${wouldBePath}:\n${res.stdout}`,
      );
      assert.match(res.stdout, /failed validation/i);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("stray relocated app bundle: receipt confirming the standard /Applications location is a no-op (not double-flagged)", () => {
  withFakePkgutilReceipt("/", "/", (shimDir) => {
    const res = spawnSync(SCRIPT_PATH, ["--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    assert.match(res.stdout, /confirms the standard install location/i);
  });
});
