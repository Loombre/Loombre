#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/smoke-packages.mjs
//
// The REAL check for the .rpm / .deb channels — the package-format sibling
// of installers/linux/smoke.mjs (which proves the tarball + install.sh).
// Each scenario runs inside a fresh container of a real target distro,
// installs the package with the distro's own package manager (so the
// derived dependencies are resolved for real), and then walks the whole
// lifecycle an operator would:
//
//   install   dnf/apt install of the local file; the scriptlets run without
//             a PID-1 systemd (a container), so the "units installed and
//             enabled, nothing started" branch is what is exercised — and
//             the enable symlinks must still exist (enable is offline-safe).
//   verify    files, modes, owners, user account, units, env file, the CLI
//             symlink, package-manager verification (rpm -V / dpkg -V with
//             md5sums), the derived dependency list.
//   boot      as the service user with the env file's values: server
//             (embedded PostgreSQL provision + auto-migrate), web (/login),
//             worker ("worker up") — exactly smoke.mjs's embedded scenario;
//             /setup/state must report needsSetup (an empty users table).
//   reinstall same version over an edited env file: the edit survives, the
//             units are re-rendered, ownership is unchanged.
//   remove    with runtime content planted in the Next cache dir: /opt/loombre
//             is GONE (the scriptlets clean what the package manager cannot),
//             the data dir, the env file and the user are KEPT.
//   purge     (deb only) nothing remains, the user is gone; a data dir that
//             is a mount point would be left alone (asserted by reading the
//             script, since a container cannot mount).
//   guard     a planted tarball install (/opt/loombre/VERSION, or a regular
//             /etc unit pointing at another prefix) makes install FAIL
//             before any file lands; an admin's full-copy unit pointing INTO
//             /opt/loombre only warns.
//   adopt     a data dir orphaned by the tarball's uninstall.sh (userdel):
//             the package recreates `loombre` with the SAME uid, and a data
//             dir owned by a live foreign account is re-owned recursively.
//
// The distro matrix (digest-pinned images): rpm on fedora:44 (a supported
// Fedora release; rpm 6 reads the v4 packages rpm 4.18 writes) and
// rockylinux:9 (the RHEL 9 floor — glibc 2.34); deb on debian:12 and
// ubuntu:24.04 (the 64-bit time_t package names). `--distros` widens it
// (debian:13, almalinux:10, fedora:43). ubuntu:26.04 is in the default
// matrix on purpose: it ships no libxml2.so.2, so it proves the vendored
// copy beside PostgreSQL (installers/libxml2-manifest.json) does its job.
//
// RESOURCE ISOLATION: host ports 3111 (server) / 3112 (web) from the
// installers/linux lane's 3100-3199 range — clear of smoke.mjs's 3101/3102
// and the dev stack. No DATABASE_URL anywhere: embedded PostgreSQL only,
// inside the container (LOOMBRE_DATA_DIR set → the shared dev Postgres
// fallback can never engage — apps/worker/src/db-url.ts resolution order).
//
//   systemd   (--systemd, opt-in, local Docker only) a PRIVILEGED container
//             booted with systemd as PID 1 (a throwaway image built on the
//             pinned base + the distro's systemd package): install must
//             enable AND start the three units for real, /healthz answers
//             through the units, /etc/loombre/no-autostart is honoured and
//             consumed, a same-version reinstall stops-before-unpack and
//             restores exactly the running units, removal while running
//             stops them (and deb's remove masks them). Needs cgroup v2 and
//             --privileged; release.yml covers the deb half natively on its
//             systemd runner, the rpm half only here.
//
// Usage:
//   node installers/linux/smoke-packages.mjs [--rpm <path>] [--deb <path>]
//        [--distros fedora:44,rockylinux:9,debian:12,ubuntu:24.04,ubuntu:26.04]
//        [--skip-boot] [--keep-containers] [--lint] [--systemd | --only-systemd]
//
// Prerequisites: docker running locally; the packages built (build-rpm.mjs /
// build-deb.mjs — the newest dist/*.rpm|deb for the host arch are used).

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LINUX_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const SERVER_PORT = 3111;
const WEB_PORT = 3112;
/** --systemd: the units bind the env file's own 3001/3000 inside the container; mapped to these host ports. */
const SYSTEMD_SERVER_HOST_PORT = 3113;
const SYSTEMD_WEB_HOST_PORT = 3114;

/** Digest-pinned images (docker pull records these; bump deliberately). */
const IMAGES = {
  "fedora:44": { ref: "fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80", family: "rpm" },
  "fedora:43": { ref: "fedora:43@sha256:a651ddf48ea28a06ed4e1e6519f51c9f47e7a5a138722ade87369b8fbb7e5b42", family: "rpm" },
  "rockylinux:9": { ref: "rockylinux:9@sha256:d7be1c094cc5845ee815d4632fe377514ee6ebcf8efaed6892889657e5ddaaa6", family: "rpm" },
  "almalinux:10": { ref: "almalinux:10@sha256:957738702313e6ee452cdb17bc1431542c467be9a4e2f4da3b8e551b0ebb9677", family: "rpm" },
  "debian:12": { ref: "debian:12@sha256:6ebd97fa83deb272194a2cf015b3d26a4d538e9ad3a7a79d544c8af5b0a01443", family: "deb" },
  "debian:13": { ref: "debian:13@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1", family: "deb" },
  "ubuntu:24.04": { ref: "ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90", family: "deb" },
  "ubuntu:26.04": { ref: "ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b", family: "deb" },
};
const DEFAULT_DISTROS = ["fedora:44", "rockylinux:9", "debian:12", "ubuntu:24.04", "ubuntu:26.04"];

export function parseArgs(argv) {
  const out = { rpm: null, deb: null, distros: DEFAULT_DISTROS, skipBoot: false, keepContainers: false, lint: false, systemd: false, onlySystemd: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rpm") out.rpm = path.resolve(argv[++i]);
    else if (arg === "--deb") out.deb = path.resolve(argv[++i]);
    else if (arg === "--distros") out.distros = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--skip-boot") out.skipBoot = true;
    else if (arg === "--keep-containers") out.keepContainers = true;
    else if (arg === "--lint") out.lint = true;
    else if (arg === "--systemd") out.systemd = true;
    else if (arg === "--only-systemd") { out.systemd = true; out.onlySystemd = true; }
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`smoke-packages: unrecognized argument ${arg}`);
  }
  for (const d of out.distros) if (!IMAGES[d]) throw new Error(`smoke-packages: unknown distro ${d} (known: ${Object.keys(IMAGES).join(", ")})`);
  return out;
}

function newestArtifact(ext) {
  const distDir = path.join(LINUX_DIR, "dist");
  if (!existsSync(distDir)) return null;
  const suffix = `-linux-${HOST_ARCH}.${ext}`;
  const found = readdirSync(distDir)
    .filter((f) => f.startsWith("loombre-") && f.endsWith(suffix))
    .map((f) => path.join(distDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

function versionFromArtifact(p) {
  const m = /^loombre-(.+)-linux-(x64|arm64)\.(rpm|deb)$/.exec(path.basename(p));
  if (!m) throw new Error(`smoke-packages: ${p} does not follow loombre-<version>-linux-<arch>.<rpm|deb>`);
  return m[1];
}

// ─────────────────────────────────────────────────────────────────────────
// Process helpers (the same shapes smoke.mjs uses)
// ─────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0 && !opts.allowFailure) throw new Error(`smoke-packages: ${cmd} ${args.join(" ")} exited ${res.status}`);
  return res;
}

/** 64 MiB output buffer: `rpm -ql` / `dpkg -L` list ~21k paths (spawnSync's
 *  1 MiB default silently kills the child with a null status). */
function capture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

class Container {
  constructor(name, image) {
    this.name = name;
    this.image = image;
  }
  start(ports = true) {
    capture("docker", ["rm", "-f", this.name]);
    const portArgs = ports ? ["-p", `${SERVER_PORT}:${SERVER_PORT}`, "-p", `${WEB_PORT}:${WEB_PORT}`] : [];
    run("docker", ["run", "-d", "--name", this.name, ...portArgs, this.image, "sleep", "infinity"]);
  }
  /** A privileged container whose PID 1 is systemd (the image's CMD). */
  startSystemd() {
    capture("docker", ["rm", "-f", this.name]);
    run("docker", [
      "run", "-d", "--name", this.name, "--privileged", "--cgroupns=host",
      "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp",
      "-p", `${SYSTEMD_SERVER_HOST_PORT}:3001`, "-p", `${SYSTEMD_WEB_HOST_PORT}:3000`,
      this.image,
    ]);
  }
  /** bash -c inside the container; returns { status, stdout, stderr, out }. */
  sh(script, { user, env = [] } = {}) {
    const res = capture("docker", ["exec", ...(user ? ["-u", user] : []), ...env.flatMap((e) => ["-e", e]), this.name, "bash", "-c", script]);
    return { ...res, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }
  /** Like sh() but throws (with the output) on a non-zero status. */
  must(script, opts = {}, what = script) {
    const res = this.sh(script, opts);
    if (res.status !== 0) throw new Error(`smoke-packages[${this.name}]: ${what} failed (exit ${res.status}):\n${res.out}`);
    return res;
  }
  detach(script, { user, env = [] } = {}) {
    run("docker", ["exec", "-d", ...(user ? ["-u", user] : []), ...env.flatMap((e) => ["-e", e]), this.name, "bash", "-c", script]);
  }
  cp(hostPath, containerPath) {
    run("docker", ["cp", hostPath, `${this.name}:${containerPath}`]);
  }
  remove() {
    capture("docker", ["rm", "-f", this.name]);
  }
}

async function waitForHttp(url, timeoutMs, want = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status === want) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`smoke-packages: ${url} never answered ${want} within ${timeoutMs} ms (last: ${last})`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`smoke-packages: ASSERTION FAILED — ${msg}`);
}

function log(msg) {
  console.log(`smoke-packages: ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-family package-manager verbs
// ─────────────────────────────────────────────────────────────────────────

const PM = {
  rpm: {
    prepare: "dnf install -y -q systemd util-linux shadow-utils procps-ng >/dev/null 2>&1 || dnf install -y -q systemd util-linux shadow-utils procps >/dev/null",
    install: (f) => `dnf install -y ${f}`,
    reinstall: (f) => `dnf reinstall -y ${f}`,
    remove: "dnf remove -y loombre",
    purge: null,
    installed: "rpm -q loombre",
    verify: "rpm -V loombre",
    deps: "rpm -q --requires loombre",
    files: "rpm -ql loombre",
    license: "rpm -q --qf '%{LICENSE}\\n' loombre",
  },
  deb: {
    prepare: "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps >/dev/null",
    install: (f) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${f} </dev/null`,
    reinstall: (f) => `DEBIAN_FRONTEND=noninteractive dpkg -i ${f} </dev/null`,
    remove: "DEBIAN_FRONTEND=noninteractive apt-get remove -y loombre </dev/null",
    purge: "DEBIAN_FRONTEND=noninteractive apt-get purge -y loombre </dev/null",
    installed: "dpkg -s loombre | grep -q '^Status: install ok installed'",
    verify: "dpkg -V loombre",
    deps: "dpkg-query -W -f='${Depends}\\n' loombre",
    files: "dpkg -L loombre",
    license: "sed -n '1,12p' /usr/share/doc/loombre/copyright",
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────

const PLANTED_CACHE = "/opt/loombre/web/apps/web/.next/cache/fetch-cache/planted";

async function lifecycle(distro, family, artifact, version, args) {
  const pm = PM[family];
  const c = new Container(`loombre-pkg-smoke-${distro.replace(/[:.]/g, "-")}`, IMAGES[distro].ref);
  const pkgInContainer = `/tmp/${path.basename(artifact)}`;
  console.log(`\n=== ${distro} (${family}) — lifecycle ===\n`);
  try {
    c.start();
    log(`${distro}: preparing (package index + systemd tooling so enable is exercised offline)`);
    c.must(pm.prepare, {}, "distro preparation");
    c.cp(artifact, pkgInContainer);

    // ── install ────────────────────────────────────────────────────────
    log(`${distro}: install`);
    const inst = c.must(pm.install(pkgInContainer), {}, "package install");
    assert(/units installed and enabled, nothing started/.test(inst.out), `install output should carry the no-systemd manual-start branch:\n${inst.out}`);
    c.must(pm.installed, {}, "package installed");

    // ── verify ─────────────────────────────────────────────────────────
    log(`${distro}: verify`);
    const v = c.must("cat /opt/loombre/VERSION").stdout.trim();
    assert(v === version, `/opt/loombre/VERSION is ${v}, expected ${version}`);
    const idLine = c.must("getent passwd loombre").stdout.trim();
    const [, , uid, , , home, shell] = idLine.split(":");
    assert(Number(uid) < 1000, `loombre must be a system account (uid ${uid})`);
    assert(home === "/var/lib/loombre", `loombre home is ${home}`);
    assert(/nologin/.test(shell), `loombre shell is ${shell}`);
    const stat = (p) => c.must(`stat -c '%a %U %G' ${p}`).stdout.trim();
    assert(stat("/var/lib/loombre") === "750 loombre loombre", `data dir: ${stat("/var/lib/loombre")}`);
    assert(stat("/opt/loombre/web/apps/web/.next/cache") === "755 loombre loombre", `cache dir: ${stat("/opt/loombre/web/apps/web/.next/cache")}`);
    assert(stat("/etc/loombre/loombre.env") === "640 root loombre", `env file: ${stat("/etc/loombre/loombre.env")}`);
    assert(stat("/usr/share/loombre/loombre.env") === "644 root root", `env default: ${stat("/usr/share/loombre/loombre.env")}`);
    // sha256sum (coreutils) rather than cmp/diff — diffutils is absent from
    // Rocky's minimal image.
    c.must('[ "$(sha256sum < /etc/loombre/loombre.env)" = "$(sha256sum < /usr/share/loombre/loombre.env)" ]', {}, "fresh env file equals the shipped default");
    for (const svc of ["loombre-server", "loombre-worker", "loombre-web"]) {
      const unit = c.must(`cat /usr/lib/systemd/system/${svc}.service`).stdout;
      assert(new RegExp(`^ExecStart=/opt/loombre/bin/${svc}$`, "m").test(unit), `${svc}: ExecStart`);
      assert(/^User=loombre$/m.test(unit) && /^EnvironmentFile=\/etc\/loombre\/loombre\.env$/m.test(unit), `${svc}: User/EnvironmentFile`);
      assert(!/^MemoryDenyWriteExecute=/m.test(unit), `${svc}: MDWE must be absent`);
      c.must(`test -L /etc/systemd/system/multi-user.target.wants/${svc}.service`, {}, `${svc} enable symlink (offline enable)`);
    }
    c.must("test ! -e /usr/local/bin/loombre", {}, "no /usr/local shim from a package");
    const cli = c.must("/usr/bin/loombre --version");
    assert(cli.stdout.includes(version), `/usr/bin/loombre --version printed ${JSON.stringify(cli.stdout.trim())}`);
    const verify = c.sh(pm.verify);
    assert(verify.status === 0 && verify.out.trim() === "", `${pm.verify} reported differences:\n${verify.out}`);
    const deps = c.must(pm.deps).stdout;
    for (const needle of family === "rpm" ? ["libssl.so.3()(64bit)", "libc.so.6(GLIBC_2.34)(64bit)", "liblzma.so.5()(64bit)"] : ["libc6 (>= 2.34)", "libssl3", "liblzma5", "adduser"]) {
      assert(deps.includes(needle), `dependencies lack ${needle}:\n${deps}`);
    }
    // libxml2.so.2 is vendored beside PostgreSQL (installers/libxml2-manifest.json)
    // precisely so no distro package is needed for it — Ubuntu 25.10+ has none.
    assert(!/libxml2/.test(deps), `libxml2 must be self-provided, not a dependency:\n${deps}`);
    c.must("test -f /opt/loombre/pg/*/*/lib/libxml2.so.2 && test -f /opt/loombre/pg/*/*/lib/LICENSE.libxml2.txt", {}, "vendored libxml2.so.2 + license present beside PostgreSQL");
    const files = c.must(pm.files).stdout.split("\n");
    for (const p of ["/usr/bin/loombre", "/usr/lib/sysusers.d/loombre.conf", "/usr/share/loombre/loombre.env", "/usr/share/doc/loombre/copyright", "/opt/loombre/bin/loombre-server"]) {
      assert(files.includes(p), `package file list lacks ${p}`);
    }
    assert(!files.includes("/etc/loombre/loombre.env"), "the live env file must not be package-owned");
    assert(files.some((f) => f.includes("/[id]/") || f.includes("/[itemType]/")), "bracket directories must be listed verbatim (no glob expansion)");
    log(`${distro}: license -> ${c.must(pm.license).stdout.trim().split("\n")[0]}`);
    if (args.lint) {
      const lint = family === "rpm"
        ? c.sh(`dnf install -y -q rpmlint >/dev/null 2>&1; rpmlint ${pkgInContainer} 2>&1 | tail -40`)
        : c.sh(`DEBIAN_FRONTEND=noninteractive apt-get install -y -qq lintian >/dev/null 2>&1; lintian --no-tag-display-limit ${pkgInContainer} 2>&1 | sort | uniq -c | sort -rn | head -40`);
      console.log(`--- ${family === "rpm" ? "rpmlint" : "lintian"} (advisory) ---\n${lint.out}`);
    }

    // ── boot (embedded PostgreSQL, the env file's own values) ──────────
    if (!args.skipBoot) {
      log(`${distro}: boot server as loombre with the generated env file (embedded PostgreSQL: initdb + migrate)`);
      const envPrefix = "set -a; . /etc/loombre/loombre.env; set +a;";
      c.detach(`${envPrefix} PORT=${SERVER_PORT} exec /opt/loombre/bin/loombre-server > /tmp/server.log 2>&1`, { user: "loombre" });
      try {
        await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`, 150_000);
      } catch (err) {
        console.error(c.sh("tail -n 60 /tmp/server.log").out);
        throw err;
      }
      const setup = await (await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/setup/state`, 30_000)).json();
      assert(setup.needsSetup === true, `/setup/state should report needsSetup:true on a fresh install, got ${JSON.stringify(setup)}`);
      log(`${distro}: /healthz 200 and /setup/state needsSetup:true`);
      c.detach(`${envPrefix} LOOMBRE_WEB_PORT=${WEB_PORT} LOOMBRE_SERVER_ORIGIN=http://localhost:${SERVER_PORT} exec /opt/loombre/bin/loombre-web > /tmp/web.log 2>&1`, { user: "loombre" });
      try {
        await waitForHttp(`http://127.0.0.1:${WEB_PORT}/login`, 90_000);
      } catch (err) {
        console.error(c.sh("tail -n 60 /tmp/web.log").out);
        throw err;
      }
      log(`${distro}: web /login 200`);
      c.detach(`${envPrefix} exec /opt/loombre/bin/loombre-worker > /tmp/worker.log 2>&1`, { user: "loombre" });
      const workerDeadline = Date.now() + 120_000;
      let workerUp = false;
      while (Date.now() < workerDeadline && !workerUp) {
        workerUp = c.sh("grep -q 'worker up' /tmp/worker.log").status === 0;
        if (!workerUp) await new Promise((r) => setTimeout(r, 2_000));
      }
      if (!workerUp) {
        console.error(c.sh("tail -n 60 /tmp/worker.log").out);
        throw new Error("worker never logged 'worker up'");
      }
      log(`${distro}: worker up (embedded DATABASE_URL discovery)`);
      const logs = c.must("ls /var/lib/loombre/logs").stdout;
      assert(/server\.log/.test(logs), `LOOMBRE_LOG_FILE tee: ${logs}`);
    }

    // ── reinstall (same version) over an edited env file ───────────────
    log(`${distro}: reinstall the same version over an edited env file`);
    c.must("echo '# operator edit — must survive' >> /etc/loombre/loombre.env");
    const envBefore = c.must("sha256sum /etc/loombre/loombre.env").stdout;
    const re = c.must(pm.reinstall(pkgInContainer), {}, "reinstall");
    assert(!/conffile|What would you like to do/i.test(re.out), `reinstall must never prompt:\n${re.out}`);
    assert(c.must("sha256sum /etc/loombre/loombre.env").stdout === envBefore, "the operator's env edit did not survive the reinstall");
    assert(stat("/etc/loombre/loombre.env") === "640 root loombre", "env file ownership after reinstall");
    assert(stat("/var/lib/loombre") === "750 loombre loombre", "data dir ownership after reinstall");
    assert(c.must("getent passwd loombre").stdout.split(":")[2] === uid, "uid changed across reinstall");
    c.must(pm.installed);

    // ── remove: /opt gone, data + env + user kept ──────────────────────
    log(`${distro}: stop the booted processes, plant runtime cache content, remove`);
    c.sh("pkill -u loombre; sleep 3; pkill -9 -u loombre; true");
    c.must(`mkdir -p $(dirname ${PLANTED_CACHE}) && touch ${PLANTED_CACHE}`, { user: "loombre" }, "plant cache content as the service user");
    // A package manager removes an EMPTY owned directory on erase — "the data
    // dir is kept" is a claim about a data dir with content (which every real
    // install has after its first boot). Plant a marker so the assertion tests
    // the claim even under --skip-boot.
    c.must("touch /var/lib/loombre/.smoke-marker", { user: "loombre" }, "plant data-dir content as the service user");
    const rm = c.must(pm.remove, {}, "remove");
    assert(/removed\. Kept/.test(rm.out), `remove output should say what was kept:\n${rm.out}`);
    c.must("test ! -e /opt/loombre", {}, "/opt/loombre gone after remove (the scriptlet cleans the runtime cache dir)");
    c.must("test ! -e /usr/bin/loombre", {}, "/usr/bin/loombre gone");
    c.must("test ! -e /usr/lib/systemd/system/loombre-server.service", {}, "units gone");
    c.must("test -f /var/lib/loombre/.smoke-marker", {}, "data dir kept with its content");
    c.must("test -f /etc/loombre/loombre.env", {}, "env file kept");
    c.must("getent passwd loombre >/dev/null", {}, "user kept after remove");
    if (family === "deb") {
      c.must("test -L /etc/systemd/system/loombre-server.service", {}, "deb remove masks the units (deb-systemd-helper mask)");
      // ── purge: nothing remains ─────────────────────────────────────
      log(`${distro}: purge`);
      const purge = c.must(pm.purge, {}, "purge");
      assert(/purged — nothing of Loombre remains/.test(purge.out), `purge output:\n${purge.out}`);
      c.must("test ! -e /var/lib/loombre && test ! -e /etc/loombre", {}, "data + config gone after purge");
      c.must("! getent passwd loombre", {}, "user gone after purge");
      c.must("test ! -L /etc/systemd/system/loombre-server.service", {}, "mask lifted on purge");
      assert(c.sh("dpkg -s loombre").status !== 0, "package still known to dpkg after purge");
    } else {
      // rpm has no purge; the erase message names the clean-slate commands.
      assert(/userdel loombre/.test(rm.out), "rpm erase message should name the clean-slate commands");
    }
    log(`${distro}: lifecycle PASSED`);
  } finally {
    if (!args.keepContainers) c.remove();
  }
}

async function guardAndAdopt(distro, family, artifact, version, args) {
  const pm = PM[family];
  const pkgInContainer = `/tmp/${path.basename(artifact)}`;
  console.log(`\n=== ${distro} (${family}) — coexistence guard + uid adoption ===\n`);
  const c = new Container(`loombre-pkg-guard-${distro.replace(/[:.]/g, "-")}`, IMAGES[distro].ref);
  try {
    c.start(false);
    c.must(pm.prepare, {}, "distro preparation");
    c.cp(artifact, pkgInContainer);

    // (1) a tarball payload at the default prefix → refuse before any file lands
    log(`${distro}: guard — planted /opt/loombre/VERSION`);
    c.must("mkdir -p /opt/loombre && echo 0.9.0 > /opt/loombre/VERSION");
    const g1 = c.sh(pm.install(pkgInContainer));
    assert(g1.status !== 0, "install must FAIL with a tarball payload present");
    assert(/unpackaged \(tarball\) Loombre install is present/.test(g1.out), `guard message missing:\n${g1.out}`);
    c.must("test ! -e /usr/bin/loombre && test ! -e /usr/lib/systemd/system/loombre-server.service", {}, "nothing installed after the guard fired");
    assert(c.sh(pm.installed).status !== 0, "package must not be recorded as installed");
    c.must("rm -rf /opt/loombre");
    // dpkg may have left the package in a half-installed state; clean it.
    if (family === "deb") c.sh("dpkg --remove --force-remove-reinstreq loombre >/dev/null 2>&1; dpkg --purge loombre >/dev/null 2>&1; true");

    // (2) a regular /etc unit pointing at ANOTHER prefix → refuse
    log(`${distro}: guard — planted /etc/systemd/system/loombre-server.service for /srv/loombre`);
    c.must("mkdir -p /etc/systemd/system && printf '[Service]\\nExecStart=/srv/loombre/bin/loombre-server\\n' > /etc/systemd/system/loombre-server.service");
    const g2 = c.sh(pm.install(pkgInContainer));
    assert(g2.status !== 0 && /unpackaged \(tarball\) Loombre install is present/.test(g2.out), `guard should refuse a foreign-prefix unit:\n${g2.out}`);
    if (family === "deb") c.sh("dpkg --remove --force-remove-reinstreq loombre >/dev/null 2>&1; dpkg --purge loombre >/dev/null 2>&1; true");

    // (3) an admin's full copy pointing INTO /opt/loombre → install succeeds with a NOTE
    log(`${distro}: guard — an admin copy pointing into /opt/loombre only warns`);
    c.must("printf '[Service]\\nExecStart=/opt/loombre/bin/loombre-server\\n' > /etc/systemd/system/loombre-server.service");
    const g3 = c.must(pm.install(pkgInContainer), {}, "install with an admin unit copy");
    assert(/shadows the packaged unit/.test(g3.out), `expected the shadowing NOTE:\n${g3.out}`);
    c.must("rm -f /etc/systemd/system/loombre-server.service");
    c.must(pm.remove);
    c.must("rm -rf /var/lib/loombre /etc/loombre; userdel loombre 2>/dev/null; groupdel loombre 2>/dev/null; true");
    if (family === "deb") c.sh("dpkg --purge loombre >/dev/null 2>&1; true");

    // (4) orphaned data dir (the tarball's uninstall.sh userdel'd the account) → uid adopted
    log(`${distro}: adopt — data dir orphaned by a userdel keeps its uid`);
    c.must("groupadd -r -g 947 loombre && useradd -r -u 947 -g loombre -d /var/lib/loombre -s /usr/sbin/nologin loombre && mkdir -p /var/lib/loombre/pg && touch /var/lib/loombre/pg/PG_VERSION && chown -R loombre:loombre /var/lib/loombre && chmod 750 /var/lib/loombre && userdel loombre && (groupdel loombre 2>/dev/null || true)");
    assert(c.sh("getent passwd loombre").status !== 0, "fixture: account must be gone");
    c.must(pm.install(pkgInContainer), {}, "install over an orphaned data dir");
    const adoptedUid = c.must("id -u loombre").stdout.trim();
    assert(adoptedUid === "947", `orphaned uid 947 should be adopted, got ${adoptedUid}`);
    assert(c.must("stat -c %U /var/lib/loombre/pg/PG_VERSION").stdout.trim() === "loombre", "surviving cluster file readable by the recreated account");
    c.must(pm.remove);
    c.must("rm -rf /var/lib/loombre /etc/loombre; userdel loombre 2>/dev/null; groupdel loombre 2>/dev/null; true");
    if (family === "deb") c.sh("dpkg --purge loombre >/dev/null 2>&1; true");

    // (5) data dir owned by a LIVE foreign account → re-owned recursively
    log(`${distro}: adopt — data dir owned by a live foreign account is re-owned`);
    c.must("useradd -r -u 948 -s /usr/sbin/nologin foreign && mkdir -p /var/lib/loombre/pg && touch /var/lib/loombre/pg/PG_VERSION && chown -R foreign:foreign /var/lib/loombre");
    const adopt2 = c.must(pm.install(pkgInContainer), {}, "install over a foreign-owned data dir");
    assert(/re-owning \/var\/lib\/loombre/.test(adopt2.out), `expected the re-own message:\n${adopt2.out}`);
    assert(c.must("id -u loombre").stdout.trim() !== "948", "a live account's uid must never be taken");
    assert(c.must("stat -c %U /var/lib/loombre/pg/PG_VERSION").stdout.trim() === "loombre", "foreign-owned content re-owned to loombre");
    log(`${distro}: guard + adopt PASSED`);
  } finally {
    if (!args.keepContainers) c.remove();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// --systemd: the live start/stop path, in a privileged PID-1-systemd container
// ─────────────────────────────────────────────────────────────────────────

function buildSystemdImage(distro, family) {
  const tag = `loombre-pkg-systemd-${distro.replace(/[:.]/g, "-")}`;
  const dockerfile = family === "rpm"
    ? `FROM ${IMAGES[distro].ref}\nRUN dnf install -y -q systemd procps-ng util-linux shadow-utils && dnf clean all\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n`
    // Debian's official images ship /usr/sbin/policy-rc.d (exit 101) so that
    // package installs inside a container never start services — which
    // deb-systemd-invoke honours by design. A real host has no such file;
    // this image is standing in for one, so drop it.
    : `FROM ${IMAGES[distro].ref}\nRUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv procps >/dev/null && apt-get clean && rm -f /usr/sbin/policy-rc.d\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n`;
  const res = spawnSync("docker", ["build", "-q", "-t", tag, "-"], { input: dockerfile, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`smoke-packages: docker build of the ${distro} systemd image failed:\n${res.stdout}${res.stderr}`);
  return tag;
}

async function waitFor(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = fn();
    if (r.ok) return r;
    last = r.detail ?? "";
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`smoke-packages: ${label} did not happen within ${timeoutMs} ms (last: ${last})`);
}

async function systemdLifecycle(distro, family, artifact, version, args) {
  const pm = PM[family];
  // NOT /tmp: the systemd container mounts a tmpfs there, and `docker cp`
  // writes into the image layer underneath that mount.
  const pkgInContainer = `/var/tmp/${path.basename(artifact)}`;
  console.log(`\n=== ${distro} (${family}) — systemd PID 1: live enable/start, no-autostart, upgrade restore, remove ===\n`);
  const image = buildSystemdImage(distro, family);
  const c = new Container(`loombre-pkg-systemd-${distro.replace(/[:.]/g, "-")}`, image);
  const active = (unit) => c.sh(`systemctl is-active ${unit}`).stdout.trim();
  const enabled = (unit) => c.sh(`systemctl is-enabled ${unit}`).stdout.trim();
  const units = ["loombre-server", "loombre-worker", "loombre-web"];
  try {
    c.startSystemd();
    await waitFor("systemd to boot", () => {
      const r = c.sh("systemctl is-system-running");
      const state = r.stdout.trim();
      return { ok: ["running", "degraded"].includes(state), detail: state || r.stderr.trim() };
    }, 90_000);
    log(`${distro}: systemd is PID 1 (${c.sh("systemctl is-system-running").stdout.trim()})`);
    if (family === "deb") c.must("apt-get update -qq", {}, "apt index");
    c.cp(artifact, pkgInContainer);

    // install → enabled + started for real, served through the units
    const inst = c.must(pm.install(pkgInContainer), {}, "install under systemd");
    assert(/services enabled and started/.test(inst.out), `expected the live-start branch:\n${inst.out}`);
    for (const u of units) assert(enabled(u) === "enabled", `${u} should be enabled, is ${enabled(u)}`);
    try {
      await waitFor("loombre-server active + /healthz through the unit", () => {
        const st = active("loombre-server");
        return { ok: st === "active", detail: st };
      }, 30_000);
    } catch (err) {
      console.error(c.sh("systemctl status loombre-server --no-pager -l; journalctl -u loombre-server --no-pager -n 40; ls -la /usr/sbin/policy-rc.d 2>&1").out);
      throw err;
    }
    await waitForHttp(`http://127.0.0.1:${SYSTEMD_SERVER_HOST_PORT}/healthz`, 150_000);
    for (const u of units) {
      await waitFor(`${u} active`, () => ({ ok: active(u) === "active", detail: active(u) }), 60_000);
    }
    await waitForHttp(`http://127.0.0.1:${SYSTEMD_WEB_HOST_PORT}/login`, 90_000);
    log(`${distro}: all three units active; /healthz and /login answer through the units`);
    assert(/StandardOutput|loombre-server/.test(c.sh("journalctl -u loombre-server --no-pager -n 5").out), "journal carries the server's output");

    // same-version reinstall while running → stop-before-unpack, then exactly those units restored
    const re = c.must(pm.reinstall(pkgInContainer), {}, "reinstall under systemd");
    assert(!/conffile|What would you like/i.test(re.out), `reinstall must never prompt:\n${re.out}`);
    c.must(`test ! -e /run/loombre-${family}-upgrade`, {}, "the upgrade marker is consumed");
    for (const u of units) {
      await waitFor(`${u} active again after the reinstall`, () => ({ ok: active(u) === "active", detail: active(u) }), 90_000);
    }
    await waitForHttp(`http://127.0.0.1:${SYSTEMD_SERVER_HOST_PORT}/healthz`, 150_000);
    log(`${distro}: reinstall stopped the units before unpack and restored all three`);

    // a stopped unit stays stopped across an upgrade (exact restoration, not "start everything")
    c.must("systemctl stop loombre-worker");
    c.must(pm.reinstall(pkgInContainer), {}, "reinstall with the worker stopped");
    await waitFor("server active after the second reinstall", () => ({ ok: active("loombre-server") === "active", detail: active("loombre-server") }), 90_000);
    assert(active("loombre-worker") !== "active", "a unit that was NOT running before the upgrade must not be started by it");
    log(`${distro}: exact restoration — the stopped worker stayed stopped`);
    c.must("systemctl start loombre-worker");

    // remove while running → stopped (+ masked on deb)
    c.must(pm.remove, {}, "remove under systemd");
    for (const u of units) assert(active(u) !== "active", `${u} still active after remove`);
    if (family === "deb") {
      assert(enabled("loombre-server") === "masked", `deb remove should mask the units, got ${enabled("loombre-server")}`);
      c.must(pm.purge, {}, "purge under systemd");
      assert(!/masked/.test(enabled("loombre-server")), "purge must unmask");
    }
    log(`${distro}: remove stopped the running units${family === "deb" ? " and masked them; purge unmasked" : ""}`);

    // no-autostart: enabled but NOT started, flag consumed
    c.must("mkdir -p /etc/loombre && touch /etc/loombre/no-autostart");
    const inst2 = c.must(pm.install(pkgInContainer), {}, "install with the no-autostart flag");
    assert(/NOT started \(flag consumed\)/.test(inst2.out), `expected the no-autostart branch:\n${inst2.out}`);
    c.must("test ! -e /etc/loombre/no-autostart", {}, "flag consumed");
    for (const u of units) {
      assert(enabled(u) === "enabled", `${u} should be enabled with the flag, is ${enabled(u)}`);
      assert(active(u) !== "active", `${u} must not be started with the flag present`);
    }
    c.must("systemctl start loombre-server loombre-worker loombre-web", {}, "manual start after the flag");
    await waitForHttp(`http://127.0.0.1:${SYSTEMD_SERVER_HOST_PORT}/healthz`, 150_000);
    log(`${distro}: no-autostart honoured and consumed; manual start works`);
    c.must(pm.remove);
    if (family === "deb") c.must(pm.purge);
    log(`${distro}: systemd scenario PASSED`);
  } finally {
    if (!args.keepContainers) {
      c.remove();
      capture("docker", ["rmi", "-f", image]);
    }
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node installers/linux/smoke-packages.mjs [--rpm <path>] [--deb <path>] [--distros a,b] [--skip-boot] [--keep-containers] [--lint] [--systemd | --only-systemd]");
    return;
  }
  if (capture("docker", ["--version"]).status !== 0) throw new Error("smoke-packages: docker not available on PATH");
  const artifacts = { rpm: args.rpm ?? newestArtifact("rpm"), deb: args.deb ?? newestArtifact("deb") };
  const results = [];
  for (const distro of args.distros) {
    const family = IMAGES[distro].family;
    const artifact = artifacts[family];
    if (!artifact) {
      log(`${distro}: SKIPPED — no .${family} artifact (build it, or pass --${family})`);
      results.push({ distro, status: "skipped" });
      continue;
    }
    const version = versionFromArtifact(artifact);
    try {
      if (!args.onlySystemd) {
        await lifecycle(distro, family, artifact, version, args);
        await guardAndAdopt(distro, family, artifact, version, args);
      }
      if (args.systemd) await systemdLifecycle(distro, family, artifact, version, args);
      results.push({ distro, status: "passed" });
    } catch (err) {
      console.error(`\n!!! ${distro}: FAILED — ${err instanceof Error ? err.message : err}\n`);
      results.push({ distro, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log("\n=== smoke-packages: summary ===");
  for (const r of results) console.log(`  ${r.status.padEnd(7)} ${r.distro}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}`);
  if (results.some((r) => r.status === "failed")) process.exit(1);
  console.log("\n=== smoke-packages: ALL CHECKS PASSED ===");
}

const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntrypoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
