// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/native-package.test.mjs
//
// Unit tests for installers/linux/lib/native-package.mjs — the shared
// staging + rendering layer behind build-rpm.mjs and build-deb.mjs. No
// Docker, no network, no fetched payload: every case works on a synthetic
// payload tree, so this runs inside `pnpm gate`'s installers-test step on
// every CI leg (ubuntu on every push; windows/macos on [full-ci] and
// dispatch — the shell-dependent cases skip themselves where bash/sh/sed
// are missing, mirroring wrapper-scripts.test.mjs).
//
// What is pinned here, and why (design record: the PKG-2026-09-05 run's
// DECISIONS entries):
//   - semver -> rpm/deb version mapping (tilde pre-releases, dropped build
//     metadata) — a wrong mapping makes `dnf upgrade` refuse the final 1.0.0
//     over 1.0.0-beta.N;
//   - the rendered env default / units are byte-identical to what the
//     tarball's install.sh writes for the default paths — the Linux channels
//     must never drift;
//   - scriptlet invariants that protect operators: enable is offline-safe
//     and unconditional on a fresh install, start/stop only with a live
//     systemd, stop-before-unpack on upgrade with exact restoration, the
//     env file is created only if absent and never touched on upgrade, an
//     orphaned data-dir uid is adopted, the tarball-coexistence guard, no
//     user removal on rpm erase, purge never rm -rf's a mount point;
//   - the rpm %files list is the SHORT recursive form (Next.js ships
//     directories literally named `[id]`, which rpm would otherwise treat as
//     glob patterns in a per-file list);
//   - the License tag and copyright file are generated from the payload's
//     npm license inventory, not hand-typed.
//
// Run: node --test installers/linux/native-package.test.mjs (or `pnpm installers:test`).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ARCHES,
  DEFAULT_PATHS,
  PACKAGE_META,
  PAYLOAD_ENTRIES,
  SERVICES,
  STOP_ORDER,
  TARBALL_ONLY_ENTRIES,
  assemblePackageRoot,
  bundledVersionsFromPayload,
  copyrightText,
  debChangelogText,
  debMd5sums,
  licenseInventory,
  parseTarballName,
  payloadPgLibRelative,
  renderDebControl,
  renderDebMaintainerScripts,
  renderEnvFile,
  renderRpmSpec,
  renderTemplate,
  renderUnit,
  rpmLicenseExpression,
  semverToDeb,
  semverToRpm,
  sysusersConf,
  templateDrift,
} from "./lib/native-package.mjs";

const LINUX_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LINUX_DIR, "../..");
const IS_WINDOWS = process.platform === "win32";
const has = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.error === undefined && r.status === 0;
};
const HAS_BASH = has("bash", ["-c", "true"]);
const HAS_SH = has("sh", ["-c", "true"]);
const HAS_SED = has("sed", ["-n", "p", "/dev/null"]) || has("sed", ["--version"]);

// ─────────────────────────────────────────────────────────────────────────
// Names, versions, arches
// ─────────────────────────────────────────────────────────────────────────

test("parseTarballName: accepts the release convention and rejects everything else", () => {
  assert.deepEqual(parseTarballName("loombre-1.0.0-beta.1-linux-arm64.tar.gz"), { name: "loombre-1.0.0-beta.1-linux-arm64", version: "1.0.0-beta.1", arch: "arm64" });
  assert.deepEqual(parseTarballName("loombre-2.3.4-linux-x64.tar.gz"), { name: "loombre-2.3.4-linux-x64", version: "2.3.4", arch: "x64" });
  assert.deepEqual(parseTarballName("/some/dir/loombre-1.0.0-rc.1-linux-x64.tar.gz"), { name: "loombre-1.0.0-rc.1-linux-x64", version: "1.0.0-rc.1", arch: "x64" });
  for (const bad of ["loombre-1.0.0-macos-arm64.pkg", "loombre-1.0.0-linux-riscv64.tar.gz", "foo-1.0.0-linux-x64.tar.gz", "loombre-1.0.0-linux-x64.zip", "loombre-notsemver-linux-x64.tar.gz"]) {
    assert.throws(() => parseTarballName(bad), new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `should reject ${bad}`);
  }
});

test("semverToRpm: pre-releases become tilde versions (sort BEFORE the final), release is always 1, build metadata is dropped", () => {
  assert.deepEqual(semverToRpm("1.0.0"), { version: "1.0.0", release: "1" });
  assert.deepEqual(semverToRpm("1.0.0-beta.1"), { version: "1.0.0~beta.1", release: "1" });
  assert.deepEqual(semverToRpm("1.0.0-rc.1"), { version: "1.0.0~rc.1", release: "1" });
  assert.deepEqual(semverToRpm("2.0.0-alpha.10"), { version: "2.0.0~alpha.10", release: "1" });
  assert.deepEqual(semverToRpm("1.2.3+build.7"), { version: "1.2.3", release: "1" });
  assert.deepEqual(semverToRpm("1.2.3-beta.2+sha.abc"), { version: "1.2.3~beta.2", release: "1" });
  for (const bad of ["1.0", "v1.0.0", "1.0.0-", "1.0.0-beta_1", "", "1.0.0-be ta"]) {
    assert.throws(() => semverToRpm(bad), /semver/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => semverToRpm("1.0.0-beta-2"), /'-'/, "a hyphenated pre-release identifier cannot be expressed and must not be silently rewritten");
});

test("semverToDeb: the same tilde mapping (dpkg --compare-versions agrees with rpm on '~')", () => {
  assert.equal(semverToDeb("1.0.0"), "1.0.0");
  assert.equal(semverToDeb("1.0.0-beta.1"), "1.0.0~beta.1");
  assert.equal(semverToDeb("1.0.0-rc.1"), "1.0.0~rc.1");
  assert.equal(semverToDeb("1.2.3+build.7"), "1.2.3");
  assert.throws(() => semverToDeb("nope"), /semver/);
});

test("ARCHES: x64/arm64 map to the rpm, deb, and ELF machine names each toolchain expects", () => {
  assert.deepEqual(ARCHES.x64, { rpm: "x86_64", deb: "amd64", elf: "x86_64", platform: "linux-x64" });
  assert.deepEqual(ARCHES.arm64, { rpm: "aarch64", deb: "arm64", elf: "aarch64", platform: "linux-arm64" });
});

test("STOP_ORDER stops the dependants first and the PostgreSQL-hosting server last", () => {
  assert.deepEqual([...STOP_ORDER], ["loombre-worker", "loombre-web", "loombre-server"]);
  assert.deepEqual([...STOP_ORDER].sort(), [...SERVICES].sort());
});

// ─────────────────────────────────────────────────────────────────────────
// Rendering — units, env file, sysusers, licenses
// ─────────────────────────────────────────────────────────────────────────

test("renderTemplate: substitutes __KEY__ placeholders globally and refuses to leave one behind", () => {
  assert.equal(renderTemplate("a=__A__ b=__B__ a2=__A__", { A: "1", B: "2" }), "a=1 b=2 a2=1");
  assert.throws(() => renderTemplate("x=__MISSING__", { A: "1" }), /__MISSING__/);
  // The replacement is literal (no regex/`$&` surprises from a path).
  assert.equal(renderTemplate("p=__P__", { P: "$&/x$1" }), "p=$&/x$1");
});

const UNIT_TEMPLATES = SERVICES.map((svc) => ({ svc, file: path.join(LINUX_DIR, "systemd", `${svc}.service.template`) }));

for (const { svc, file } of UNIT_TEMPLATES) {
  test(`renderUnit(${svc}): identical to install.sh's sed rendering for the default paths`, { skip: !HAS_SED && "sed not available" }, () => {
    const template = readFileSync(file, "utf8");
    const viaJs = renderUnit(template, DEFAULT_PATHS);
    // The exact expressions install.sh uses (installers/linux/install.sh, the
    // `for svc in ...` loop) — kept verbatim so a drift there shows up here.
    const viaSed = spawnSync(
      "sed",
      [
        "-e", `s#__PREFIX__#${DEFAULT_PATHS.prefix}#g`,
        "-e", `s#__DATA_DIR__#${DEFAULT_PATHS.dataDir}#g`,
        "-e", `s#__CONFIG_DIR__#${DEFAULT_PATHS.configDir}#g`,
        "-e", `s#__LOOMBRE_USER__#${DEFAULT_PATHS.user}#g`,
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(viaSed.status, 0, viaSed.stderr);
    assert.equal(viaJs, viaSed.stdout);
    assert.match(viaJs, /^ExecStart=\/opt\/loombre\/bin\//m);
    assert.match(viaJs, /^EnvironmentFile=\/etc\/loombre\/loombre\.env$/m);
    assert.match(viaJs, /^User=loombre$/m);
    assert.doesNotMatch(viaJs, /^MemoryDenyWriteExecute=/m, "MDWE is incompatible with V8's JIT — the templates document why it must stay absent");
    assert.doesNotMatch(viaJs, /__[A-Z_]+__/, "unrendered placeholder");
  });
}

test("renderEnvFile: identical to install.sh's sed rendering of loombre.env.template for the default paths, and carries the documented knobs", { skip: !HAS_SED && "sed not available" }, () => {
  const file = path.join(LINUX_DIR, "loombre.env.template");
  const template = readFileSync(file, "utf8");
  const viaJs = renderEnvFile(template, DEFAULT_PATHS);
  const viaSed = spawnSync("sed", ["-e", `s#__DATA_DIR__#${DEFAULT_PATHS.dataDir}#g`, "-e", `s#__PREFIX__#${DEFAULT_PATHS.prefix}#g`, file], { encoding: "utf8" });
  assert.equal(viaSed.status, 0, viaSed.stderr);
  assert.equal(viaJs, viaSed.stdout);
  assert.match(viaJs, /^PORT=3001$/m);
  assert.match(viaJs, /^LOOMBRE_DATA_DIR=\/var\/lib\/loombre$/m);
  assert.match(viaJs, /^#DATABASE_URL=/m);
  assert.match(viaJs, /^#LOOMBRE_EMBEDDED_PG_VENDOR_DIR=\/opt\/loombre\/pg$/m);
  assert.doesNotMatch(viaJs, /__[A-Z_]+__/);
});

test("sysusersConf: declares the system user + group with the data dir as home and a nologin shell", () => {
  const text = sysusersConf(DEFAULT_PATHS);
  assert.match(text, /^g loombre -$/m);
  assert.match(text, /^u loombre - "Loombre media server" \/var\/lib\/loombre \/usr\/sbin\/nologin$/m);
});

test("rpmLicenseExpression: fixed head plus every inventory identifier, compound ids parenthesised, duplicates dropped", () => {
  const inv = new Map([["MIT", 300], ["ISC", 20], ["(MIT OR CC0-1.0)", 2], ["Apache-2.0", 5], ["BlueOak-1.0.0", 1]]);
  assert.equal(
    rpmLicenseExpression(inv),
    "AGPL-3.0-only AND GPL-3.0-or-later AND PostgreSQL AND MIT AND (MIT OR CC0-1.0) AND Apache-2.0 AND BlueOak-1.0.0 AND ISC",
  );
});

test("copyrightText / debChangelogText: DEP-5 stanzas name every bundled component and version, carry the AGPL + PostgreSQL texts verbatim and the npm inventory", () => {
  const bundled = { node: "24.18.0", ffmpeg: "8.1.2", postgresql: "18.4.0" };
  const inventory = new Map([["MIT", 309], ["ISC", 21], ["(MIT OR CC0-1.0)", 2]]);
  const copyright = copyrightText({ version: "1.0.0-beta.1", bundled, inventory, agplText: "GNU AFFERO GENERAL PUBLIC LICENSE\n\nVersion 3", postgresqlText: "PostgreSQL Database Management System\n(also known as Postgres)" });
  for (const needle of [
    "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/",
    "License: AGPL-3.0-only", "License: GPL-3.0-or-later", "License: PostgreSQL", "License: MIT",
    "24.18.0", "8.1.2", "18.4.0",
    "/opt/loombre/ffmpeg/LICENSE.txt", "/opt/loombre/runtime/node/LICENSE", "https://github.com/Loombre/Loombre",
    "  MIT: 309", "  ISC: 21", "  (MIT OR CC0-1.0): 2",
    " GNU AFFERO GENERAL PUBLIC LICENSE\n .\n Version 3",
    " PostgreSQL Database Management System",
  ]) {
    assert.ok(copyright.includes(needle), `copyright lacks ${JSON.stringify(needle)}`);
  }
  const changelog = debChangelogText({ debVersion: "1.0.0~beta.1", date: "Fri, 05 Sep 2026 00:00:00 +0000" });
  assert.match(changelog, /^loombre \(1\.0\.0~beta\.1\) unstable; urgency=medium$/m);
  assert.match(changelog, /^ -- Loombre Project <[^>]+>  Fri, 05 Sep 2026 00:00:00 \+0000$/m);
});

// ─────────────────────────────────────────────────────────────────────────
// Staging — a synthetic payload through assemblePackageRoot
// ─────────────────────────────────────────────────────────────────────────

function makePayload(root, { version = "1.0.0-beta.1", arch = "arm64", withTemplates = true } = {}) {
  const name = `loombre-${version}-linux-${arch}`;
  const payload = path.join(root, name);
  const put = (rel, content, mode) => {
    const full = path.join(payload, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, { mode });
  };
  put("VERSION", `${version}\n`);
  for (const bin of ["loombre", "loombre-server", "loombre-worker", "loombre-web"]) put(`bin/${bin}`, "#!/usr/bin/env bash\nexit 0\n", 0o755);
  put("lib/server/dist/main.js", "console.log('server')\n");
  put("lib/server/node_modules/.pnpm/foo@1/node_modules/foo/index.js", "module.exports = 1\n");
  put("lib/server/node_modules/.pnpm/foo@1/node_modules/foo/package.json", JSON.stringify({ name: "foo", version: "1.0.0", license: "MIT" }));
  put("lib/server/node_modules/.pnpm/bar@2/node_modules/bar/package.json", JSON.stringify({ name: "bar", version: "2.0.0", license: "(MIT OR CC0-1.0)" }));
  put("lib/worker/node_modules/.pnpm/baz@3/node_modules/baz/package.json", JSON.stringify({ name: "baz", version: "3.0.0", licenses: [{ type: "ISC" }] }));
  put("lib/worker/node_modules/.pnpm/nolicense@1/node_modules/nolicense/package.json", JSON.stringify({ name: "nolicense", version: "1.0.0" }));
  put("web/apps/web/server.js", "console.log('web')\n");
  put("web/apps/web/.next/server/app/items/[id]/page.js", "// bracket dir — a literal path, not a glob\n");
  put("runtime/node/bin/node", "#!/bin/sh\necho fake-node\n", 0o755);
  put("runtime/node/LICENSE", "Node.js is licensed for use as follows: MIT\n");
  put("ffmpeg/ffmpeg", "#!/bin/sh\n", 0o755);
  put("ffmpeg/ffprobe", "#!/bin/sh\n", 0o755);
  put("ffmpeg/LICENSE.txt", "GPL\n");
  put(`pg/linux-${arch}/18.4.0/bin/postgres`, "#!/bin/sh\n", 0o755);
  put(`pg/linux-${arch}/18.4.0/lib/libpq.so.5`, "not really\n");
  put(`pg/linux-${arch}/18.4.0/LICENSE`, "PostgreSQL Database Management System\n");
  put("packages/release-manifest/dist/index.js", "export {}\n");
  put("install.sh", readFileSync(path.join(LINUX_DIR, "install.sh"), "utf8"), 0o755);
  put("uninstall.sh", readFileSync(path.join(LINUX_DIR, "uninstall.sh"), "utf8"), 0o755);
  if (withTemplates) {
    for (const svc of SERVICES) put(`systemd/${svc}.service.template`, readFileSync(path.join(LINUX_DIR, "systemd", `${svc}.service.template`), "utf8"));
    put("loombre.env.template", readFileSync(path.join(LINUX_DIR, "loombre.env.template"), "utf8"));
  }
  // A world-writable file — the staging step must clamp it (install.sh does
  // chmod -R go-w on the payload).
  put("lib/server/loose.txt", "x\n", 0o666);
  // A pnpm-style symlink, which must survive staging as a symlink.
  if (!IS_WINDOWS) {
    const linkDir = path.join(payload, "lib/server/node_modules");
    mkdirSync(linkDir, { recursive: true });
    spawnSync("ln", ["-s", ".pnpm/foo@1/node_modules/foo", path.join(linkDir, "foo")]);
  }
  return { payload, name };
}

function withTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "loombre-native-package-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASSEMBLE_DEFAULTS = { paths: DEFAULT_PATHS, templatesDir: LINUX_DIR, version: "1.0.0-beta.1", bundled: { node: "24.18.0", ffmpeg: "8.1.2", postgresql: "18.4.0" }, licensePath: path.join(REPO_ROOT, "LICENSE") };

test("PAYLOAD_ENTRIES mirrors install.sh's payload copy list; TARBALL_ONLY_ENTRIES are the installer-channel files a package never ships", () => {
  const installSh = readFileSync(path.join(LINUX_DIR, "install.sh"), "utf8");
  const m = /for entry in ([a-zA-Z ]+); do/.exec(installSh);
  assert.ok(m, "install.sh: payload copy loop not found");
  assert.deepEqual([...PAYLOAD_ENTRIES].sort(), m[1].trim().split(/\s+/).sort());
  assert.deepEqual([...TARBALL_ONLY_ENTRIES].sort(), ["install.sh", "loombre.env.template", "systemd", "uninstall.sh"]);
});

test("payloadPgLibRelative: finds the single pg/<platform>/<version>/lib dir and refuses ambiguity", () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    assert.equal(payloadPgLibRelative(payload), "pg/linux-arm64/18.4.0/lib");
    mkdirSync(path.join(payload, "pg/linux-arm64/17.10.0/lib"), { recursive: true });
    assert.throws(() => payloadPgLibRelative(payload), /exactly one/);
  });
});

test("bundledVersionsFromPayload: PostgreSQL from the payload dir name, Node + ffmpeg from the pinned manifests", () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    const v = bundledVersionsFromPayload(payload, REPO_ROOT);
    assert.equal(v.postgresql, "18.4.0");
    assert.match(v.node, /^\d+\.\d+\.\d+$/);
    assert.match(v.ffmpeg, /^\d+\.\d+(\.\d+)?$/);
  });
});

test("licenseInventory: counts every declared license under node_modules (string, object, legacy array forms), skips undeclared, sorts by count", () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    const inv = licenseInventory(payload);
    assert.deepEqual([...inv.entries()], [["(MIT OR CC0-1.0)", 1], ["ISC", 1], ["MIT", 1]]);
  });
});

test("templateDrift: a tarball whose bundled templates or installer scripts differ from the checkout's is reported file-by-file", () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    assert.deepEqual(templateDrift(payload, LINUX_DIR), []);
    writeFileSync(path.join(payload, "systemd", "loombre-web.service.template"), "changed\n");
    rmSync(path.join(payload, "loombre.env.template"));
    writeFileSync(path.join(payload, "install.sh"), "#!/bin/sh\n# stale\n");
    const drift = templateDrift(payload, LINUX_DIR).map((d) => `${d.file}: ${d.reason}`).sort();
    assert.deepEqual(drift, ["install.sh: differs from the checkout", "loombre.env.template: missing in the tarball", "systemd/loombre-web.service.template: differs from the checkout"]);
  });
});

test("assemblePackageRoot: builds the FHS tree — payload under /opt/loombre, env DEFAULT under /usr/share (never /etc), empty /etc/loombre, units, sysusers, /usr/bin symlink, data dir, docs; never the tarball-only files; symlinks preserved; go-w clamped; no /usr/local", { skip: IS_WINDOWS && "symlinks + POSIX modes (the builders never run on Windows)" }, () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    const rootDir = path.join(dir, "root");
    const result = assemblePackageRoot({ payloadDir: payload, rootDir, ...ASSEMBLE_DEFAULTS });

    const at = (p) => path.join(rootDir, p);
    for (const entry of PAYLOAD_ENTRIES) assert.ok(existsSync(at(`opt/loombre/${entry}`)), `missing /opt/loombre/${entry}`);
    for (const entry of TARBALL_ONLY_ENTRIES) assert.ok(!existsSync(at(`opt/loombre/${entry}`)), `tarball-only ${entry} leaked into the package`);
    assert.ok(!existsSync(at("usr/local")), "/usr/local must never appear in a package");
    assert.ok(!existsSync(at("opt/loombre/web/apps/web/.next/cache")), "the writable cache dir is created by the install scriptlets, never shipped");

    const envDefault = renderEnvFile(readFileSync(path.join(LINUX_DIR, "loombre.env.template"), "utf8"), DEFAULT_PATHS);
    assert.equal(readFileSync(at("usr/share/loombre/loombre.env"), "utf8"), envDefault);
    assert.ok(!existsSync(at("etc/loombre/loombre.env")), "the live env file is maintainer-script managed — a package must never ship it");
    assert.ok(statSync(at("etc/loombre")).isDirectory(), "/etc/loombre ships empty so a pre-install restore and the scriptlet copy have a home");
    for (const svc of SERVICES) {
      assert.equal(readFileSync(at(`usr/lib/systemd/system/${svc}.service`), "utf8"), renderUnit(readFileSync(path.join(LINUX_DIR, "systemd", `${svc}.service.template`), "utf8"), DEFAULT_PATHS));
    }
    assert.equal(readFileSync(at("usr/lib/sysusers.d/loombre.conf"), "utf8"), sysusersConf(DEFAULT_PATHS));
    assert.equal(readlinkSync(at("usr/bin/loombre")), "/opt/loombre/bin/loombre");
    assert.ok(statSync(at("var/lib/loombre")).isDirectory());
    const copyright = readFileSync(at("usr/share/doc/loombre/copyright"), "utf8");
    assert.ok(copyright.includes("18.4.0") && copyright.includes("GNU AFFERO GENERAL PUBLIC LICENSE") && copyright.includes("PostgreSQL Database Management System"));
    assert.ok(copyright.includes("  MIT: 1"), "npm inventory folded into the copyright file");
    assert.ok(readFileSync(at("usr/share/licenses/loombre/LICENSE"), "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE"));

    // pnpm-style symlink preserved as a symlink (not dereferenced, not dropped).
    assert.ok(lstatSync(at("opt/loombre/lib/server/node_modules/foo")).isSymbolicLink());
    // go-w clamp, executables keep +x, data dir 0750, env default 0644.
    assert.equal(statSync(at("opt/loombre/lib/server/loose.txt")).mode & 0o022, 0);
    assert.equal(statSync(at("opt/loombre/bin/loombre-server")).mode & 0o111, 0o111);
    assert.equal(statSync(at("var/lib/loombre")).mode & 0o777, 0o750);
    assert.equal(statSync(at("usr/share/loombre/loombre.env")).mode & 0o777, 0o644);
    // The bracket directory survives verbatim.
    assert.ok(existsSync(at("opt/loombre/web/apps/web/.next/server/app/items/[id]/page.js")));

    assert.deepEqual(result.units.map((u) => u.name).sort(), SERVICES.map((s) => `${s}.service`).sort());
    assert.equal(result.version, "1.0.0-beta.1");
    assert.deepEqual([...result.inventory.keys()].sort(), ["(MIT OR CC0-1.0)", "ISC", "MIT"]);
  });
});

test("assemblePackageRoot: refuses a payload whose VERSION disagrees with the tarball name, and a payload missing a required entry", { skip: IS_WINDOWS && "symlinks (the builders never run on Windows)" }, () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    writeFileSync(path.join(payload, "VERSION"), "9.9.9\n");
    assert.throws(() => assemblePackageRoot({ payloadDir: payload, rootDir: path.join(dir, "r1"), ...ASSEMBLE_DEFAULTS }), /VERSION/);
  });
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    rmSync(path.join(payload, "pg"), { recursive: true });
    assert.throws(() => assemblePackageRoot({ payloadDir: payload, rootDir: path.join(dir, "r2"), ...ASSEMBLE_DEFAULTS }), /pg/);
  });
});

test("debMd5sums: one line per regular file in the data tree (DEBIAN/ excluded), md5 + two spaces + relative path, sorted by path", { skip: IS_WINDOWS && "symlinks" }, () => {
  withTemp((dir) => {
    const { payload } = makePayload(dir);
    const rootDir = path.join(dir, "root");
    assemblePackageRoot({ payloadDir: payload, rootDir, ...ASSEMBLE_DEFAULTS });
    mkdirSync(path.join(rootDir, "DEBIAN"));
    writeFileSync(path.join(rootDir, "DEBIAN", "control"), "Package: x\n");
    const text = debMd5sums(rootDir);
    const lines = text.trimEnd().split("\n");
    for (const line of lines) assert.match(line, /^[0-9a-f]{32}  [^/]/);
    const paths = lines.map((l) => l.slice(34));
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(paths.includes("opt/loombre/VERSION"));
    assert.ok(paths.includes("usr/share/loombre/loombre.env"));
    assert.ok(!paths.some((p) => p.startsWith("DEBIAN/")));
    assert.ok(!paths.includes("opt/loombre/lib/server/node_modules/foo"), "symlinks are not checksummed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// rpm spec
// ─────────────────────────────────────────────────────────────────────────

function specFixture(overrides = {}) {
  return renderRpmSpec({
    meta: PACKAGE_META,
    paths: DEFAULT_PATHS,
    version: "1.0.0-beta.1",
    rpmVersion: "1.0.0~beta.1",
    release: "1",
    requires: ["libc.so.6()(64bit)", "libc.so.6(GLIBC_2.34)(64bit)", "libssl.so.3()(64bit)"],
    bundled: { node: "24.18.0", ffmpeg: "8.1.2", postgresql: "18.4.0" },
    licenseExpression: "AGPL-3.0-only AND GPL-3.0-or-later AND PostgreSQL AND MIT AND ISC",
    ...overrides,
  });
}

/** A line that RUNS the tool as a statement — not a comment, not an echo
 *  naming it, not a `command -v` presence probe, not an `if`/`elif`/`while`
 *  condition (whose exit status is consumed by the conditional). */
function isCommandLine(line, toolPattern) {
  const t = line.trim();
  return toolPattern.test(t) && !t.startsWith("#") && !t.startsWith("echo ") && !/^(if |elif |while |until )/.test(t) && !/^command -v /.test(t);
}

function section(spec, name) {
  const re = new RegExp(`^%${name}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)(?=^%(?:pre|post|preun|postun|posttrans|files|description|changelog)\\b|(?![\\s\\S]))`, "m");
  const m = re.exec(spec);
  assert.ok(m, `spec has no %${name} section`);
  return m[1];
}

test("rpm spec: header — name, tilde version, release 1, generated SPDX license, explicit deps only, package-name Requires(pre), no systemd Requires, bundled() provides", () => {
  const spec = specFixture();
  assert.match(spec, /^Name:\s+loombre$/m);
  assert.match(spec, /^Version:\s+1\.0\.0~beta\.1$/m);
  assert.match(spec, /^Release:\s+1$/m, "Release must not carry %{?dist}: one package for every rpm distro");
  assert.match(spec, /^License:\s+AGPL-3\.0-only AND GPL-3\.0-or-later AND PostgreSQL AND MIT AND ISC$/m);
  assert.match(spec, /^URL:\s+https:\/\/github\.com\/Loombre\/Loombre$/m);
  assert.match(spec, /^AutoReq:\s+no$/m);
  assert.match(spec, /^AutoProv:\s+yes$/m, "rpm >= 4.19 generates user()/group() Requires from %attr owners; only its sysusers Provides generator satisfies them");
  assert.match(spec, /^%global __provides_exclude_from \^\/opt\/loombre\/\.\*\$$/m, "the bundled libpq/libvips must never be offered to other packages");
  assert.doesNotMatch(spec, /^AutoReqProv/m);
  assert.match(spec, /^Requires:\s+libc\.so\.6\(GLIBC_2\.34\)\(64bit\)$/m);
  assert.match(spec, /^Requires:\s+libssl\.so\.3\(\)\(64bit\)$/m);
  assert.match(spec, /^Requires\(pre\):\s+\(shadow-utils or shadow\)$/m, "a package name (rich dep), not a file path: Fedora 42+ merged /usr/sbin");
  assert.doesNotMatch(spec, /^Requires(\([a-z]+\))?:\s+\/usr\/(s?bin)\//m, "no file-path Requires");
  assert.doesNotMatch(spec, /^Requires(\([a-z]+\))?:\s+.*systemctl|^Requires(\([a-z]+\))?:\s+systemd/m, "systemd must not be required — containers/chroots install without it");
  assert.match(spec, /^Provides:\s+bundled\(nodejs\) = 24\.18\.0$/m);
  assert.match(spec, /^Provides:\s+bundled\(ffmpeg\) = 8\.1\.2$/m);
  assert.match(spec, /^Provides:\s+bundled\(postgresql\) = 18\.4\.0$/m);
});

test("rpm spec: no comment line carries a live macro reference (rpm expands %name inside comments — a %__spec_install_pre mention injected rpm's build-environment script into the preamble on the first real build)", () => {
  const spec = specFixture();
  for (const line of spec.split("\n").filter((l) => l.startsWith("#"))) {
    const live = line.replace(/%%/g, "").match(/%[{a-zA-Z_]/);
    assert.equal(live, null, `comment line with an unescaped macro reference: ${line}`);
  }
});

test("rpm spec: bundled-binary hygiene — no strip, no shebang mangling, no rpath check, no debuginfo, xz payload, buildroot never wiped", () => {
  const spec = specFixture();
  assert.match(spec, /^%global debug_package %\{nil\}$/m);
  assert.match(spec, /^%global __os_install_post %\{nil\}$/m);
  assert.match(spec, /^%undefine __brp_mangle_shebangs$/m);
  assert.match(spec, /^%global __brp_check_rpaths %\{nil\}$/m);
  assert.match(spec, /^%global _build_id_links none$/m);
  assert.match(spec, /^%define _binary_payload w6T0\.xzdio$/m, "xz level 6, all cores");
  assert.match(spec, /^%global _binary_filedigest_algorithm 8$/m, "SHA-256 file digests regardless of the builder's macros");
  assert.match(spec, /^%global __spec_install_pre %\{nil\}$/m, "rpm's default %__spec_install_pre rm -rf's the buildroot we pre-populated");
  assert.doesNotMatch(spec, /^%install\b/m, "an %install section would trigger the buildroot wipe");
  assert.doesNotMatch(spec, /^%prep\b|^%build\b/m);
});

test("rpm spec: %files is the short recursive form (no per-file globs: Next.js ships `[id]` directories); the env DEFAULT is packaged, the live env file is not; special paths listed once each", () => {
  const files = section(specFixture(), "files");
  assert.match(files, /^%defattr\(-,root,root,-\)$/m);
  assert.match(files, /^\/opt\/loombre$/m, "/opt/loombre must be listed ONCE, recursively");
  assert.match(files, /^%dir %attr\(0750,loombre,loombre\) \/var\/lib\/loombre$/m);
  assert.match(files, /^%dir \/etc\/loombre$/m);
  assert.match(files, /^%dir \/usr\/share\/loombre$/m);
  assert.match(files, /^\/usr\/share\/loombre\/loombre\.env$/m);
  assert.doesNotMatch(files, /\/etc\/loombre\/loombre\.env/, "the live env file is scriptlet-managed, never packaged (no .rpmorig/.rpmnew surprises)");
  assert.match(files, /^%ghost %dir %attr\(0755,loombre,loombre\) \/opt\/loombre\/web\/apps\/web\/\.next\/cache$/m);
  for (const svc of SERVICES) assert.match(files, new RegExp(`^/usr/lib/systemd/system/${svc}\\.service$`, "m"));
  assert.match(files, /^\/usr\/lib\/sysusers\.d\/loombre\.conf$/m);
  assert.match(files, /^\/usr\/bin\/loombre$/m);
  assert.match(files, /^%license \/usr\/share\/licenses\/loombre\/LICENSE$/m);
  assert.match(files, /^%doc \/usr\/share\/doc\/loombre\/copyright$/m);
  assert.doesNotMatch(files, /\/usr\/local/);
  assert.doesNotMatch(files, /^\/opt\/loombre\/[a-z]/m, "no per-file entries under /opt/loombre (they would double-list and be glob-expanded)");
  for (const owned of ["/usr/bin", "/usr/lib/systemd/system", "/usr/lib/sysusers.d", "/usr/share/doc", "/usr/share/licenses", "/usr/share", "/etc", "/var/lib", "/opt"]) {
    assert.doesNotMatch(files, new RegExp(`^%dir ${owned.replace(/\//g, "\\/")}$`, "m"), `claims ${owned}, which another package owns`);
  }
});

test("rpm scriptlets: systemd tolerated absent everywhere; enable on fresh install is unconditional, start/stop gated on a live systemd; upgrade = stop-before-unpack + exact restore; env created only if absent; orphaned uid adopted; user never removed; coexistence guard on fresh installs only", () => {
  const spec = specFixture();
  const pre = section(spec, "pre");
  const post = section(spec, "post");
  const preun = section(spec, "preun");
  const postun = section(spec, "postun");
  const posttrans = section(spec, "posttrans");

  for (const [name, body] of [["pre", pre], ["post", post], ["preun", preun], ["postun", postun], ["posttrans", posttrans]]) {
    for (const line of body.split("\n").filter((l) => isCommandLine(l, /\bsystemctl\b/))) {
      assert.match(line, /\|\| :\s*$/, `%${name}: systemctl statement without '|| :' -> ${line.trim()}`);
    }
    assert.match(body, /^exit 0$/m, `%${name} must end with exit 0`);
    assert.doesNotMatch(body, /\brpm -q|\bdnf\b|\bzypper\b/, `%${name} must not query the package manager mid-transaction`);
  }
  // %pre: stale marker cleared; guard only on $1 == 1 and only for a REGULAR
  // unit file (a mask symlink is not a tarball unit); orphaned uid/gid
  // adoption; group before user; stop-before-unpack on upgrade.
  assert.match(pre, /^rm -f \/run\/loombre-rpm-upgrade$/m);
  assert.match(pre, /if \[ "\$1" -eq 1 \]; then\n  _foreign=""\n  if \[ -e \/opt\/loombre\/VERSION \]; then/);
  assert.match(pre, /elif \[ -f \/etc\/systemd\/system\/loombre-server\.service \] && \[ ! -L \/etc\/systemd\/system\/loombre-server\.service \] && ! grep -q "\^ExecStart=\/opt\/loombre\/" \/etc\/systemd\/system\/loombre-server\.service 2>\/dev\/null; then/, "a regular /etc unit aborts only when it points at ANOTHER prefix (an admin's full copy of the packaged unit is warned about, not fatal)");
  assert.match(pre, /uninstall\.sh/, "the guard must tell the operator what to run");
  assert.match(pre, /_owner_uid=\$\(stat -c %u \/var\/lib\/loombre/);
  assert.match(pre, /getent passwd "\$_owner_uid" >\/dev\/null; then _adopt_uid="\$_owner_uid"/);
  assert.match(pre, /groupadd -r \$\{_adopt_gid:\+-g "\$_adopt_gid"\} loombre \|\| exit 1/);
  assert.match(pre, /useradd -r \$\{_adopt_uid:\+-u "\$_adopt_uid"\} -g loombre -d \/var\/lib\/loombre -s \/sbin\/nologin -c "Loombre media server" loombre \|\| exit 1/);
  assert.ok(pre.indexOf("groupadd") < pre.indexOf("useradd"));
  assert.match(pre, /if \[ "\$1" -ge 2 \] && \[ -d \/run\/systemd\/system \]; then/);
  assert.match(pre, /for _u in loombre-worker\.service loombre-web\.service loombre-server\.service; do/);
  assert.match(pre, /if systemctl is-active --quiet "\$_u" 2>\/dev\/null; then echo "\$_u" >> \/run\/loombre-rpm-upgrade; fi/);
  assert.match(pre, /systemctl stop loombre-worker\.service loombre-web\.service loombre-server\.service >\/dev\/null 2>&1 \|\| :/);
  // %post: cache dir; data-dir re-own only when a child is foreign-owned;
  // env file copied from the shipped default only if absent; enable
  // unconditionally on fresh install; start only with live systemd and no
  // flag; manual-start lines otherwise; no enable on upgrades.
  assert.match(post, /mkdir -p \/opt\/loombre\/web\/apps\/web\/\.next\/cache \|\| :/);
  assert.match(post, /chown loombre:loombre \/opt\/loombre\/web\/apps\/web\/\.next\/cache \|\| :/);
  assert.match(post, /find \/var\/lib\/loombre -mindepth 1 -maxdepth 1 ! -user loombre -print -quit/);
  assert.match(post, /chown -R loombre:loombre \/var\/lib\/loombre \|\| echo/);
  assert.match(post, /if \[ ! -e \/etc\/loombre\/loombre\.env \]; then\n  cp \/usr\/share\/loombre\/loombre\.env \/etc\/loombre\/loombre\.env \|\| echo "loombre: WARNING[^\n]*" >&2\nfi/);
  assert.match(post, /chown root:loombre \/etc\/loombre\/loombre\.env \|\| :/);
  assert.match(post, /chmod 0640 \/etc\/loombre\/loombre\.env \|\| :/);
  assert.match(post, /if \[ "\$1" -eq 1 \]; then\n  systemctl enable loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null 2>&1 \|\| :\n  if \[ -d \/run\/systemd\/system \]; then/);
  assert.match(post, /if \[ -e \/etc\/loombre\/no-autostart \]; then/);
  assert.match(post, /rm -f \/etc\/loombre\/no-autostart/);
  assert.match(post, /systemctl start loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null 2>&1 \|\| :/);
  assert.match(post, /http:\/\/localhost:3000/);
  assert.match(post, /\/opt\/loombre\/bin\/loombre-server"/, "manual-start line for hosts without systemd");
  assert.doesNotMatch(post, /enable --now/, "enable and start are separate: enable is offline-safe, start needs PID 1");
  assert.match(post, /shadows the packaged unit/);
  // %preun: stop+disable on erase ($1 == 0) only — an upgrade's stop already
  // happened in the new package's %pre.
  assert.match(preun, /if \[ "\$1" -eq 0 \]/);
  assert.match(preun, /systemctl --no-reload disable --now loombre-worker\.service loombre-web\.service loombre-server\.service/);
  assert.doesNotMatch(preun, /-ge 1|-eq 1/);
  // %postun: reload; on erase clean the runtime cache dir + an EXPLICIT parent chain (never rmdir -p), keep data + env + user.
  assert.match(postun, /if \[ "\$1" -eq 0 \]/);
  assert.match(postun, /rm -rf \/opt\/loombre\/web\/apps\/web\/\.next\/cache/);
  assert.match(postun, /rmdir \/opt\/loombre\/web\/apps\/web\/\.next >\/dev\/null 2>&1 \|\| :/);
  assert.match(postun, /rmdir \/opt\/loombre >\/dev\/null 2>&1 \|\| :/);
  assert.doesNotMatch(postun, /rmdir -p|rmdir --ignore-fail-on-non-empty -p/);
  assert.doesNotMatch(postun, /rmdir \/opt >\/dev/);
  for (const line of postun.split("\n").filter((l) => isCommandLine(l, /userdel|rm -rf \/var\/lib\/loombre|rm -rf \/etc\/loombre|rm -f \/etc\/loombre\/loombre\.env/))) {
    assert.fail(`rpm erase must never delete the user, the data dir, or the env file, but %postun runs: ${line.trim()}`);
  }
  // %posttrans: start exactly the units %pre recorded, then drop the marker.
  assert.match(posttrans, /if \[ -f \/run\/loombre-rpm-upgrade \]; then\n  _units=\$\(cat \/run\/loombre-rpm-upgrade\)\n  rm -f \/run\/loombre-rpm-upgrade/);
  assert.match(posttrans, /systemctl start \$_units >\/dev\/null 2>&1 \|\| :/);
  assert.doesNotMatch(posttrans, /try-restart|enable/);
});

test("rpm scriptlets: POSIX sh — every section passes `sh -n` and `bash -n`", { skip: !(HAS_SH || HAS_BASH) && "no sh/bash" }, () => {
  const spec = specFixture();
  for (const name of ["pre", "post", "preun", "postun", "posttrans"]) {
    const body = section(spec, name);
    for (const shell of [HAS_SH && "sh", HAS_BASH && "bash"].filter(Boolean)) {
      const res = spawnSync(shell, ["-n"], { input: body, encoding: "utf8" });
      assert.equal(res.status, 0, `%${name} fails ${shell} -n:\n${res.stderr}`);
    }
  }
});

test("rpm %pre user creation: behavioural — the ${var:+-u \"$var\"} idiom expands to two words with a value and to nothing without", { skip: !HAS_SH && "no sh" }, () => {
  const res = spawnSync("sh", ["-c", `f() { printf "%s|" "$@"; }; _adopt_uid="1234"; f useradd -r \${_adopt_uid:+-u "$_adopt_uid"} -g loombre loombre; echo; _adopt_uid=""; f useradd -r \${_adopt_uid:+-u "$_adopt_uid"} -g loombre loombre`], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const [withUid, withoutUid] = res.stdout.split("\n");
  assert.equal(withUid, "useradd|-r|-u|1234|-g|loombre|loombre|");
  assert.equal(withoutUid, "useradd|-r|-g|loombre|loombre|");
});

// ─────────────────────────────────────────────────────────────────────────
// deb control + maintainer scripts
// ─────────────────────────────────────────────────────────────────────────

function debFixture(overrides = {}) {
  return {
    control: renderDebControl({
      meta: PACKAGE_META,
      debVersion: "1.0.0~beta.1",
      debArch: "arm64",
      depends: ["libc6 (>= 2.34)", "libssl3t64 | libssl3", "libstdc++6"],
      installedSizeKb: 543210,
      ...overrides,
    }),
    scripts: renderDebMaintainerScripts({ paths: DEFAULT_PATHS }),
  };
}

test("deb control: required fields, tilde version, arch, alternatives-bearing Depends plus adduser (init-system-helpers is Essential — never listed), wrapped description", () => {
  const { control } = debFixture();
  assert.match(control, /^Package: loombre$/m);
  assert.match(control, /^Version: 1\.0\.0~beta\.1$/m);
  assert.match(control, /^Architecture: arm64$/m);
  assert.match(control, /^Maintainer: Loombre Project <[^>]+>$/m);
  assert.match(control, /^Installed-Size: 543210$/m);
  assert.match(control, /^Section: video$/m);
  assert.match(control, /^Priority: optional$/m);
  assert.match(control, /^Homepage: https:\/\/github\.com\/Loombre\/Loombre$/m);
  const depends = /^Depends: (.*)$/m.exec(control)[1].split(", ");
  for (const d of ["libc6 (>= 2.34)", "libssl3t64 | libssl3", "libstdc++6", "adduser"]) assert.ok(depends.includes(d), `Depends lacks ${d}: ${depends}`);
  assert.ok(!depends.some((d) => d.startsWith("init-system-helpers")), "Essential packages are never listed (lintian: depends-on-essential-package-without-using-version)");
  assert.ok(!depends.some((d) => /systemd/.test(d)), "systemd must not be a dependency — containers install without it");
  assert.doesNotMatch(control, /^Pre-Depends:/m);
  assert.match(control, /^Description: Self-hosted media streaming platform \(server, worker, web UI\)$/m);
  const desc = control.slice(control.indexOf("Description:"));
  for (const line of desc.split("\n").slice(1).filter(Boolean)) {
    assert.match(line, /^ /, `description continuation line must start with a space: ${JSON.stringify(line)}`);
    assert.ok(line.length <= 80, `description line over 80 columns: ${line}`);
  }
  assert.ok(control.endsWith("\n"));
});

test("deb maintainer scripts: no conffile; preinst guard on a first install only; postinst adopts uid, statoverrides ownership, creates env only if absent, enables unconditionally, starts per marker/flag/fresh with live systemd; prerm stops on remove and records+stops on upgrade; postrm masks on remove, purges data/config/user on purge only and never a mount point", () => {
  const { scripts } = debFixture();
  const { preinst, postinst, prerm, postrm } = scripts;
  assert.equal(scripts.conffiles, undefined, "the env file is maintainer-script managed (Policy 10.7.3) — no conffile, no upgrade prompt");

  for (const [name, body] of Object.entries({ preinst, postinst, prerm, postrm })) {
    assert.match(body, /^#!\/bin\/sh\n/, `${name} must be POSIX sh`);
    assert.match(body, /^set -e$/m, `${name} must set -e (Debian Policy 10.4)`);
    for (const line of body.split("\n").filter((l) => isCommandLine(l, /\b(systemctl|deb-systemd-invoke|deb-systemd-helper)\b/))) {
      assert.match(line, /\|\| true\s*$/, `${name}: service-manager statement without '|| true' -> ${line.trim()}`);
    }
    assert.doesNotMatch(body, /\bdpkg -S|\bdpkg-query|\bapt\b/, `${name} must not query dpkg mid-transaction`);
  }
  // preinst: only `install` with NO configured version runs the guard (a
  // reinstall after a plain remove passes $2); regular-file check.
  assert.match(preinst, /if \[ "\$1" = "install" \] && \[ -z "\$2" \]; then\n  _foreign=""\n  if \[ -e \/opt\/loombre\/VERSION \]; then/);
  assert.match(preinst, /elif \[ -f \/etc\/systemd\/system\/loombre-server\.service \] && \[ ! -L \/etc\/systemd\/system\/loombre-server\.service \] && ! grep -q "\^ExecStart=\/opt\/loombre\/"/);
  assert.match(preinst, /uninstall\.sh/);
  // postinst configure
  assert.match(postinst, /if \[ "\$1" = "configure" \]/);
  assert.match(postinst, /addgroup --quiet --system \$\{_adopt_gid:\+--gid "\$_adopt_gid"\} loombre/);
  assert.match(postinst, /adduser --quiet --system \$\{_adopt_uid:\+--uid "\$_adopt_uid"\} --ingroup loombre --home \/var\/lib\/loombre --no-create-home --shell \/usr\/sbin\/nologin --gecos "Loombre media server" loombre/);
  assert.match(postinst, /if ! dpkg-statoverride --list \/var\/lib\/loombre >\/dev\/null 2>&1; then\n\s+dpkg-statoverride --update --add loombre loombre 0750 \/var\/lib\/loombre/);
  assert.match(postinst, /dpkg-statoverride --update --add loombre loombre 0755 \/opt\/loombre\/web\/apps\/web\/\.next\/cache/);
  assert.match(postinst, /find \/var\/lib\/loombre -mindepth 1 -maxdepth 1 ! -user loombre -print -quit/);
  assert.match(postinst, /if \[ ! -e \/etc\/loombre\/loombre\.env \]; then\n\s+cp \/usr\/share\/loombre\/loombre\.env \/etc\/loombre\/loombre\.env \|\| echo "loombre: WARNING[^\n]*" >&2\n\s+fi/);
  assert.match(postinst, /chown root:loombre \/etc\/loombre\/loombre\.env \|\| true/);
  assert.match(postinst, /chmod 0640 \/etc\/loombre\/loombre\.env \|\| true/);
  // Enablement OUTSIDE the live-systemd guard (offline-safe), dh's was-enabled dance.
  const enableIdx = postinst.indexOf("deb-systemd-helper unmask");
  const liveIdx = postinst.indexOf("if [ -d /run/systemd/system ]; then");
  assert.ok(enableIdx > 0 && liveIdx > enableIdx, "enable must run before (outside) the live-systemd guard");
  assert.match(postinst, /if deb-systemd-helper --quiet was-enabled "\$_u"; then\n\s+deb-systemd-helper enable "\$_u" >\/dev\/null \|\| true\n\s+else\n\s+deb-systemd-helper update-state "\$_u" >\/dev\/null \|\| true/);
  assert.match(postinst, /if \[ -f \/run\/loombre-deb-upgrade \]; then/);
  assert.match(postinst, /deb-systemd-invoke start \$_units >\/dev\/null \|\| true/);
  assert.match(postinst, /elif \[ -e \/etc\/loombre\/no-autostart \]; then/);
  assert.match(postinst, /rm -f \/etc\/loombre\/no-autostart/);
  assert.match(postinst, /deb-systemd-invoke start loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null \|\| true/);
  assert.doesNotMatch(postinst, /if \[ -z "\$2" \]/, "$2 is set on a reinstall after remove too — start decisions must not key on it");
  assert.doesNotMatch(postinst, /try-restart|systemctl enable --now/);
  assert.match(postinst, /http:\/\/localhost:3000/);
  assert.match(postinst, /\/opt\/loombre\/bin\/loombre-server"/, "manual-start line for hosts without systemd");
  // prerm
  assert.match(prerm, /"remove"\)\n\s+if \[ -d \/run\/systemd\/system \]; then\n\s+deb-systemd-invoke stop loombre-worker\.service loombre-web\.service loombre-server\.service >\/dev\/null \|\| true/);
  assert.match(prerm, /"upgrade"\)/);
  assert.match(prerm, /rm -f \/run\/loombre-deb-upgrade/);
  assert.match(prerm, /if systemctl is-active --quiet "\$_u" 2>\/dev\/null; then echo "\$_u" >> \/run\/loombre-deb-upgrade; fi/);
  assert.match(prerm, /if \[ -s \/run\/loombre-deb-upgrade \]; then\n\s+deb-systemd-invoke stop loombre-worker\.service loombre-web\.service loombre-server\.service >\/dev\/null \|\| true/);
  // postrm
  const remove = postrm.slice(postrm.indexOf('"remove")'), postrm.indexOf('"purge")'));
  const purge = postrm.slice(postrm.indexOf('"purge")'), postrm.indexOf("  *)"));
  assert.match(remove, /rm -rf \/opt\/loombre\/web\/apps\/web\/\.next\/cache/);
  assert.match(remove, /rmdir \/opt\/loombre >\/dev\/null 2>&1 \|\| true/);
  assert.match(remove, /deb-systemd-helper mask loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null \|\| true/);
  assert.doesNotMatch(remove, /rm -rf \/var\/lib\/loombre|rm -rf \/etc\/loombre|deluser/, "plain remove keeps data, config, and the user");
  assert.match(purge, /deb-systemd-helper purge loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null \|\| true/);
  assert.match(purge, /deb-systemd-helper unmask loombre-server\.service loombre-worker\.service loombre-web\.service >\/dev\/null \|\| true/);
  assert.match(purge, /dpkg-statoverride --remove \/var\/lib\/loombre >\/dev\/null 2>&1 \|\| true/);
  assert.match(purge, /if mountpoint -q \/var\/lib\/loombre 2>\/dev\/null; then\n\s+echo[^\n]*mount point[^\n]*\n\s+else\n\s+rm -rf \/var\/lib\/loombre\n\s+fi/);
  assert.match(purge, /rm -rf \/etc\/loombre/);
  assert.match(purge, /deluser --quiet --system loombre >\/dev\/null 2>&1 \|\| echo/);
  assert.match(purge, /delgroup --quiet --system loombre >\/dev\/null 2>&1 \|\| true/);
  assert.doesNotMatch(postrm, /rmdir -p/);
});

test("deb maintainer scripts: POSIX sh — all four pass `sh -n` and `bash -n`", { skip: !(HAS_SH || HAS_BASH) && "no sh/bash" }, () => {
  const { scripts } = debFixture();
  for (const name of ["preinst", "postinst", "prerm", "postrm"]) {
    for (const shell of [HAS_SH && "sh", HAS_BASH && "bash"].filter(Boolean)) {
      const res = spawnSync(shell, ["-n"], { input: scripts[name], encoding: "utf8" });
      assert.equal(res.status, 0, `${name} fails ${shell} -n:\n${res.stderr}`);
    }
  }
});
