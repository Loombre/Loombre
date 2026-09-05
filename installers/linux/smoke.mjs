#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/smoke.mjs
//
// The REAL check for the Linux tarball + systemd distribution channel
// (P4.1). Inside a fresh ubuntu:24.04 container: extracts the built
// tarball, runs install.sh --no-systemd, boots server+worker with the
// BUNDLED node against the loombre_i1 database (external-PG path — P4.2),
// asserts /healthz 200 and a real login round-trip via the seeded admin,
// then asserts a clean (non-purge) uninstall leaves NO FILES OUTSIDE THE
// DATA DIR. Since the installer completeness audit it ALSO proves the
// EMBEDDED-mode out-of-the-box path (the wrapper's DATABASE_URL-unset
// default): a second scenario re-installs and boots server (embedded PG
// provision + auto-migrate), web (bin/loombre-web serving /login), and
// worker (embedded DATABASE_URL discovery via LOOMBRE_DATA_DIR) with NO
// DATABASE_URL anywhere — see the "embedded scenario" block below.
//
// RESOURCE ISOLATION (this lane's dispatch): ports 3100-3199 (3101 =
// server, 3102 = web), database `loombre_i1` on the shared dev Postgres
// (127.0.0.1:5442) — NEVER the `loombre` database (that is another lane's
// / the base dev environment's, off-limits). Every DATABASE_URL this
// script builds is asserted to target `loombre_i1` before use — see
// assertSafeDatabaseUrl below. This assertion exists because an earlier
// session mistake (documented in the I1 handoff report) booted a real app
// process with no DATABASE_URL override at all, which would have
// defaulted straight at the shared `loombre` database — never again
// silently. (The embedded scenario deliberately sets NO DATABASE_URL —
// that is safe by construction, not an exception: with LOOMBRE_DATA_DIR
// set, both apps resolve the container-local embedded cluster
// [apps/worker/src/db-url.ts resolution order]; the shared-dev-PG
// fallback only exists when LOOMBRE_DATA_DIR is ALSO unset.)
//
// Wires into NOTHING (ci.yml untouched — release wiring is lane I's).
//
// Usage:
//   node installers/linux/smoke.mjs [--tarball <path>] [--keep-container]
//                                    [--container-name <name>] [--fresh]
//
//   --fresh  force a tarball rebuild even if dist/ has one (ensureTarball
//            also rebuilds automatically when anything under
//            installers/linux is newer than the existing tarball — the
//            old behavior reused ANY stale dist artifact, which silently
//            smoked outdated bits after every installer edit).
//
// Prerequisites: docker running locally; the shared dev Postgres
// container up (`docker compose -f docker-compose.dev.yml up -d`,
// 127.0.0.1:5442, user/password `loombre`) — this script does NOT start
// it, only connects to it.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const INSTALLERS_LINUX_DIR = __dirname;

const SMOKE_DB_NAME = "loombre_i1";
const SMOKE_DB_HOST_URL = `postgres://loombre:loombre@127.0.0.1:5442/${SMOKE_DB_NAME}`;
const SMOKE_DB_CONTAINER_URL = `postgres://loombre:loombre@host.docker.internal:5442/${SMOKE_DB_NAME}`;
const SMOKE_SERVER_PORT = 3101; // this lane's assigned range: 3100-3199
const SMOKE_WEB_PORT = 3102; // bin/loombre-web (embedded scenario) — same assigned range
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "loombre-seed-admin"; // packages/db/seed/seed.mjs — argon2id('loombre-seed-admin')

function assertSafeDatabaseUrl(url) {
  if (!url.includes(`/${SMOKE_DB_NAME}`) || url.includes("/loombre?") || url.endsWith("/loombre")) {
    throw new Error(
      `smoke: REFUSING to use DATABASE_URL ${JSON.stringify(url)} — it does not clearly target the isolated ${SMOKE_DB_NAME} ` +
        `database. This check exists specifically so this script can never default onto the shared 'loombre' dev database.`,
    );
  }
  return url;
}
assertSafeDatabaseUrl(SMOKE_DB_HOST_URL);
assertSafeDatabaseUrl(SMOKE_DB_CONTAINER_URL);

function parseArgs(argv) {
  const out = { tarball: null, keepContainer: false, containerName: "loombre_i1-smoke", fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball") out.tarball = resolve(argv[++i]);
    else if (arg === "--keep-container") out.keepContainer = true;
    else if (arg === "--container-name") out.containerName = argv[++i];
    else if (arg === "--fresh") out.fresh = true;
    else throw new Error(`smoke: unrecognized argument ${JSON.stringify(arg)}`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`smoke: command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
  return result.status;
}

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────
// DB bootstrap — resolves `pg` from this repo's own pnpm store (same "no
// new deps" discipline as scripts/fetch-ffmpeg.mjs) since installers/linux
// has no node_modules of its own.
// ─────────────────────────────────────────────────────────────────────────

async function resolvePgClientCtor() {
  const storeDir = join(REPO_ROOT, "node_modules", ".pnpm");
  const entry = readdirSync(storeDir).find((e) => e.startsWith("pg@"));
  if (!entry) throw new Error("smoke: pg not found in the local pnpm store");
  const pgEntryPath = join(storeDir, entry, "node_modules", "pg", "esm", "index.mjs");
  const mod = await import(pathToFileURL(pgEntryPath).href);
  return mod.default?.Client ?? mod.Client;
}

async function ensureSmokeDatabase() {
  const Client = await resolvePgClientCtor();
  const client = new Client({ connectionString: "postgres://loombre:loombre@127.0.0.1:5442/postgres" });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [SMOKE_DB_NAME]);
    if (rows.length > 0) {
      console.log(`smoke: database ${SMOKE_DB_NAME} already exists — reusing`);
      return;
    }
    // Identifier interpolation (not parameterizable in CREATE DATABASE):
    // SMOKE_DB_NAME is this file's own hardcoded constant, never
    // user/CLI-supplied, so this is not an injection surface.
    await client.query(`CREATE DATABASE ${SMOKE_DB_NAME}`);
    console.log(`smoke: created database ${SMOKE_DB_NAME}`);
  } finally {
    await client.end();
  }
}

async function alreadySeeded() {
  const Client = await resolvePgClientCtor();
  const client = new Client({ connectionString: assertSafeDatabaseUrl(SMOKE_DB_HOST_URL) });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM users WHERE username = $1", [ADMIN_USERNAME]);
    return rows.length > 0;
  } catch {
    return false; // e.g. `users` doesn't exist yet (migrations haven't run) — not seeded
  } finally {
    await client.end();
  }
}

async function migrateAndSeed() {
  const env = { ...process.env, DATABASE_URL: assertSafeDatabaseUrl(SMOKE_DB_HOST_URL) };
  console.log(`smoke: migrating ${SMOKE_DB_NAME} (DATABASE_URL=${env.DATABASE_URL})`);
  const dbDir = join(REPO_ROOT, "packages", "db");
  // Invoke the underlying scripts directly (`node scripts/migrate.mjs
  // migrate` / `node seed/seed.mjs` — see packages/db/package.json's own
  // db:migrate/db:seed scripts) rather than `pnpm --filter ... run` —
  // this workspace's shared lockfile/node_modules state is mutated by
  // several concurrently-running Phase-4 lanes, and `pnpm run` inserts an
  // implicit "deps status check" that can abort non-interactively
  // (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) on transient drift this
  // lane neither caused nor may fix (LOCKFILE FROZEN). Calling node
  // directly bypasses that check entirely and needs nothing from pnpm
  // beyond what's already resolved on disk.
  run(process.execPath, ["scripts/migrate.mjs", "migrate"], { cwd: dbDir, env });
  // seed.mjs is not itself re-run-safe (plain INSERTs, no ON CONFLICT) —
  // this smoke test IS safe to re-run (e.g. after a prior partial
  // failure), so skip seeding if the admin user this test logs in as is
  // already present rather than erroring on a duplicate-key violation.
  if (await alreadySeeded()) {
    console.log(`smoke: ${SMOKE_DB_NAME} already seeded (admin user present) — skipping db:seed`);
    return;
  }
  run(process.execPath, ["seed/seed.mjs"], { cwd: dbDir, env });
}

// ─────────────────────────────────────────────────────────────────────────
// Tarball
// ─────────────────────────────────────────────────────────────────────────

// The tarball arch follows the HOST arch (darwin-arm64 dev host → the
// linux-arm64 tarball runs natively in the arm64 ubuntu container; CI's
// x64 ubuntu keeps x64). The old hardcoded "-linux-x64" default made this
// host's smoke silently pick up a stale x64 artifact and die on a rosetta
// loader error inside the arm64 container (supported-latest sweep find —
// the same foot-gun the rename run's "--arch arm64" note recorded).
const TARBALL_ARCH = process.arch === "arm64" ? "arm64" : "x64";

/** Newest mtime (ms) of any file under `dir`, skipping the build outputs
 *  themselves (dist/, .build/) — the "is the existing tarball stale?"
 *  input set: build-tarball.mjs, install.sh, uninstall.sh, systemd/*,
 *  this file's siblings. App-source staleness is NOT tracked here (that
 *  would mean walking the whole repo); --fresh covers that case. */
function newestInstallerInputMtimeMs(dir) {
  // The .rpm/.deb builders (build-rpm.mjs, build-deb.mjs, lib/, their tests,
  // smoke-packages.mjs) consume the tarball and never change its bytes, so
  // editing them must not force a rebuild here; loombre.env.template IS a
  // tarball input and stays in the walk.
  const SKIP = new Set([
    "dist", ".build", ".DS_Store",
    "lib", "build-rpm.mjs", "build-deb.mjs", "smoke-packages.mjs",
    "native-package.test.mjs", "elf-deps.test.mjs", "LAYOUT.md", "smoke.mjs",
  ]);
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestInstallerInputMtimeMs(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function ensureTarball(explicitPath, fresh = false) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`smoke: --tarball ${explicitPath} does not exist`);
    return explicitPath;
  }
  const suffix = `-linux-${TARBALL_ARCH}.tar.gz`;
  const distDir = join(INSTALLERS_LINUX_DIR, "dist");
  if (!fresh && existsSync(distDir)) {
    const existing = readdirSync(distDir).filter((f) => f.endsWith(suffix));
    if (existing.length > 0) {
      const path = join(distDir, existing.sort().at(-1));
      // Installer completeness audit (gap 6): the old unconditional reuse
      // silently smoked a STALE dist tarball after every installer edit —
      // an audit run proved a days-old artifact was being "verified" while
      // build-tarball.mjs had changed underneath it. Reuse only when the
      // tarball is newer than every installer input file.
      const inputMtime = newestInstallerInputMtimeMs(INSTALLERS_LINUX_DIR);
      const tarballMtime = statSync(path).mtimeMs;
      if (tarballMtime >= inputMtime) {
        console.log(`smoke: reusing existing tarball ${path} (newer than all installers/linux inputs)`);
        return path;
      }
      console.log(
        `smoke: existing tarball ${path} is STALE (an installers/linux input is newer) — rebuilding`,
      );
    }
  }
  console.log(`smoke: building tarball (node installers/linux/build-tarball.mjs)${fresh ? " [--fresh]" : ""}`);
  run(process.execPath, [join(INSTALLERS_LINUX_DIR, "build-tarball.mjs"), "--arch", TARBALL_ARCH], { cwd: REPO_ROOT });
  const built = readdirSync(distDir).filter((f) => f.endsWith(suffix));
  if (built.length === 0) throw new Error("smoke: build-tarball.mjs ran but produced no tarball");
  return join(distDir, built.sort().at(-1));
}

// ─────────────────────────────────────────────────────────────────────────
// Container lifecycle
// ─────────────────────────────────────────────────────────────────────────

function removeContainerIfExists(name) {
  runCapture("docker", ["rm", "-f", name]); // ignore failure — fine if it didn't exist
}

function dockerExec(name, args, opts = {}) {
  return run("docker", ["exec", ...(opts.user ? ["-u", opts.user] : []), ...(opts.env ?? []).flatMap((e) => ["-e", e]), name, ...args], opts);
}

function dockerExecCapture(name, args, opts = {}) {
  return runCapture("docker", ["exec", ...(opts.user ? ["-u", opts.user] : []), name, ...args]);
}

async function waitForHttp200(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return true;
      lastErr = new Error(`GET ${url} -> HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`smoke: ${url} never returned 200 within ${timeoutMs}ms — last error: ${lastErr?.message ?? lastErr}`);
}

/** Polls until nothing answers on the port — the inverse of
 *  waitForHealthz, used between scenarios so a surviving process can
 *  never masquerade as the next scenario's server. */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`smoke: port ${port} still answering after ${timeoutMs}ms — previous scenario's server survived teardown`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForHealthz(port, timeoutMs) {
  return waitForHttp200(`http://127.0.0.1:${port}/healthz`, timeoutMs);
}

/** Polls a log file INSIDE the container for a substring — used by the
 *  embedded scenario to catch the worker's own "worker up" boot line
 *  (apps/worker/src/index.ts logs it once the queue + plugin-delivery
 *  loop are live, i.e. after embedded DATABASE_URL discovery succeeded). */
async function waitForContainerLogLine(containerName, logPath, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const grep = dockerExecCapture(containerName, ["bash", "-c", `grep -F ${JSON.stringify(needle)} ${logPath} 2>/dev/null`]);
    if (grep.status === 0 && grep.stdout.trim().length > 0) return grep.stdout.trim();
    if (Date.now() >= deadline) {
      const tail = dockerExecCapture(containerName, ["bash", "-c", `tail -n 40 ${logPath} 2>&1`]);
      throw new Error(
        `smoke: ${JSON.stringify(needle)} never appeared in ${logPath} within ${timeoutMs}ms — log tail:\n${tail.stdout}${tail.stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function buildDeviceProfile() {
  // Mirrors scripts/perf-t0.mjs's buildDeviceProfile() — a minimal valid
  // device capability profile for the /auth/login contract.
  return {
    profileId: "smoke-i1-harness",
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "h264", maxProfile: null, maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 20_000_000 },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// L2: /usr/local/bin/loombre PATH shim — the H2-recovery invocability fix
// (docs-verbatim proof: `loombre --version` / `loombre admin reset-pin
// --help` must both work from a fresh shell with no path prefix once
// install.sh has run). See installers/linux/install.sh's shim block and
// the writeWrapperScripts() bin/loombre wrapper in build-tarball.mjs.
// ─────────────────────────────────────────────────────────────────────────

function combinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function assertShimResolvesUnderPrefix(containerName, prefix) {
  const resolved = dockerExecCapture(containerName, ["bash", "-c", "readlink -f /usr/local/bin/loombre"]);
  const target = resolved.stdout.trim();
  console.log(`smoke: readlink -f /usr/local/bin/loombre -> ${JSON.stringify(target)}`);
  if (resolved.status !== 0 || !target.startsWith(`${prefix}/`)) {
    throw new Error(`smoke: /usr/local/bin/loombre does not resolve under ${prefix} (readlink -f gave ${JSON.stringify(target)}, exit ${resolved.status})`);
  }
}

/** The docs-verbatim proof (B-5): from a FRESH shell with no path prefix
 *  (`bash -lc`, no inherited cwd/env from this script) — both commands
 *  below must work via the bare `loombre` name on PATH. This is the
 *  H2-recovery invocability fix: `admin reset-pin` is the PIN-reset
 *  recovery procedure (docs/ops/cli.md), and it must be reachable without
 *  first hunting down the tarball's install root. */
function assertCliInvocable(containerName) {
  const version = dockerExecCapture(containerName, ["bash", "-lc", "loombre --version"]);
  console.log(`smoke: [H2-recovery invocability fix] loombre --version -> exit=${version.status} stdout=${JSON.stringify(version.stdout.trim())}`);
  if (version.status !== 0) {
    throw new Error(`smoke: 'loombre --version' exited ${version.status} from a fresh shell (H2-recovery invocability fix) — stderr: ${version.stderr}`);
  }
  if (!/^Loombre \d+\.\d+\.\d+/.test(version.stdout.trim())) {
    throw new Error(`smoke: 'loombre --version' printed unexpected output: ${JSON.stringify(version.stdout)}`);
  }

  const help = dockerExecCapture(containerName, ["bash", "-lc", "loombre admin reset-pin --help"]);
  console.log(`smoke: [H2-recovery invocability fix] loombre admin reset-pin --help -> exit=${help.status}`);
  console.log(
    help.stdout
      .trim()
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  if (help.status !== 0) {
    throw new Error(`smoke: 'loombre admin reset-pin --help' exited ${help.status} from a fresh shell (H2-recovery invocability fix) — stderr: ${help.stderr}`);
  }
  if (!help.stdout.includes("loombre admin reset-pin <username>")) {
    throw new Error(`smoke: 'loombre admin reset-pin --help' did not print usage: ${JSON.stringify(help.stdout)}`);
  }
  console.log(
    "smoke: H2-recovery invocability fix PROVEN — `loombre --version` and `loombre admin reset-pin --help` " +
      "both work from a fresh shell with no path prefix.",
  );
}

async function loginRoundTrip(port) {
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      deviceName: "smoke-i1-harness",
      deviceProfile: buildDeviceProfile(),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`smoke: login failed -> HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const pair = await res.json();
  if (!pair.accessToken || typeof pair.accessToken !== "string") {
    throw new Error(`smoke: login response had no accessToken: ${JSON.stringify(pair).slice(0, 500)}`);
  }
  console.log("smoke: login round-trip OK (accessToken received)");
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  const dockerVersion = runCapture("docker", ["--version"]);
  if (dockerVersion.status !== 0) throw new Error("smoke: docker not available on PATH");

  await ensureSmokeDatabase();
  await migrateAndSeed();

  const tarballPath = ensureTarball(args.tarball, args.fresh);
  const tarballName = tarballPath.split("/").at(-1).replace(/\.tar\.gz$/, "");
  console.log(`\n=== smoke: ${tarballName} ===\n`);

  removeContainerIfExists(args.containerName);
  try {
    console.log("--- starting container ---");
    run("docker", [
      "run", "-d", "--name", args.containerName,
      "--add-host=host.docker.internal:host-gateway",
      "-p", `${SMOKE_SERVER_PORT}:${SMOKE_SERVER_PORT}`,
      "-p", `${SMOKE_WEB_PORT}:${SMOKE_WEB_PORT}`, // embedded scenario's bin/loombre-web
      "ubuntu:24.04", "sleep", "infinity",
    ]);

    console.log("--- installing embedded-PG runtime library prerequisites ---");
    // The bundled PostgreSQL (theseus-rs builds) dynamically links
    // libgssapi_krb5.so.2 + libxml2.so.2 — present on ordinary server
    // installs, absent from minimal containers. ldd-probed exhaustively
    // (installer completeness follow-up): ldd-probed over EVERY pg binary
    // (psql needs libreadline8 too — round-8 smoke). install.sh warns about them; docs list them.
    dockerExec(args.containerName, ["bash", "-c", "apt-get update -qq && apt-get install -y -qq libgssapi-krb5-2 libxml2 libreadline8 >/dev/null"]);

    console.log("--- copying + extracting tarball ---");
    run("docker", ["cp", tarballPath, `${args.containerName}:/tmp/${tarballName}.tar.gz`]);
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp && tar xzf ${tarballName}.tar.gz`]);

    console.log("--- install.sh --no-systemd ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);

    // The systemd path itself cannot run here — this container has no
    // init — so assert the CONTRACT against the install.sh that actually
    // shipped in the tarball. Until the rc.1 install-visibility fix this
    // script `enable`d the units and stopped, printing a `systemctl start`
    // line: a successful install left the machine with nothing running,
    // the Linux face of the same "install succeeded, nothing happened"
    // report that hit macOS and Windows.
    console.log("--- shipped install.sh starts the stack by default (--no-start opts out) ---");
    const shippedInstallSh = dockerExecCapture(args.containerName, [
      "bash",
      "-c",
      `cat /tmp/${tarballName}/install.sh`,
    ]).stdout;
    if (!/systemctl\s+enable\s+--now\s/.test(shippedInstallSh)) {
      throw new Error(
        "shipped install.sh never runs `systemctl enable --now` — an install would enable the units without starting them, leaving no running server and no UI",
      );
    }
    if (!/--no-start\)/.test(shippedInstallSh)) {
      throw new Error(
        "shipped install.sh does not accept --no-start — operators who need to edit the env file before anything binds a port have no opt-out",
      );
    }
    // The dependency preflight must run BEFORE the units are started, or a
    // default install's first visible behaviour on a host missing
    // libgssapi/libxml2/libreadline is a crash-looping server with the
    // explanation scrolled off the top. Ordering is the whole point, so
    // assert ordering, not mere presence.
    const preflightAt = shippedInstallSh.indexOf("pg_lib_preflight");
    const enableNowAt = shippedInstallSh.search(/systemctl\s+enable\s+--now\s/);
    if (preflightAt === -1) {
      throw new Error("shipped install.sh has no pg_lib_preflight — missing PostgreSQL libraries would surface as a crash loop, not a message");
    }
    if (preflightAt > enableNowAt) {
      throw new Error("pg_lib_preflight runs AFTER `systemctl enable --now` — the dependency check must precede any service start");
    }
    for (const flag of ["--install-deps", "--no-install-deps"]) {
      if (!shippedInstallSh.includes(`${flag})`)) {
        throw new Error(`shipped install.sh does not accept ${flag}`);
      }
    }
    console.log("smoke: install.sh dependency-preflight contract OK (runs before start; --install-deps/--no-install-deps present)");

    console.log("--- L2 / H2-recovery invocability fix: PATH shim + CLI reachability (docs-verbatim proof) ---");
    assertShimResolvesUnderPrefix(args.containerName, "/opt/loombre");
    assertCliInvocable(args.containerName);

    console.log("--- booting server + worker (bundled node, external-PG path) ---");
    // `docker exec -d` is required to actually background inside the
    // container — dockerExec()/run() otherwise block (spawnSync + stdio
    // inherit) waiting for a process that never exits. stdout/stderr are
    // redirected to log files inside the container (a bare `docker exec
    // -d` process's output is otherwise not retrievable at all) so a
    // failure to reach /healthz below can be diagnosed instead of just
    // timing out silently.
    // LOOMBRE_DATA_DIR mirrors what install.sh's generated loombre.env
    // provides in the systemd-managed path (EnvironmentFile=) — the
    // wrapper scripts `cd` into it (see writeWrapperScripts in
    // build-tarball.mjs) so app-relative default paths land somewhere
    // writable instead of wherever the invoker's cwd happened to be.
    run("docker", [
      "exec", "-d", "-u", "loombre",
      "-e", `PORT=${SMOKE_SERVER_PORT}`, "-e", `DATABASE_URL=${assertSafeDatabaseUrl(SMOKE_DB_CONTAINER_URL)}`, "-e", "NODE_ENV=production", "-e", "LOOMBRE_DATA_DIR=/var/lib/loombre",
      args.containerName, "bash", "-c", "/opt/loombre/bin/loombre-server > /tmp/loombre-server.log 2>&1",
    ]);
    run("docker", [
      "exec", "-d", "-u", "loombre",
      "-e", `DATABASE_URL=${assertSafeDatabaseUrl(SMOKE_DB_CONTAINER_URL)}`, "-e", "NODE_ENV=production", "-e", "LOOMBRE_DATA_DIR=/var/lib/loombre",
      args.containerName, "bash", "-c", "/opt/loombre/bin/loombre-worker > /tmp/loombre-worker.log 2>&1",
    ]);

    console.log("--- waiting for /healthz ---");
    try {
      await waitForHealthz(SMOKE_SERVER_PORT, 30_000);
    } catch (err) {
      console.error("--- /healthz never came up — dumping in-container logs for diagnosis ---");
      dockerExec(args.containerName, ["bash", "-c", "echo '=== loombre-server.log ==='; cat /tmp/loombre-server.log 2>&1; echo '=== loombre-worker.log ==='; cat /tmp/loombre-worker.log 2>&1"], { allowFailure: true });
      throw err;
    }
    console.log("smoke: /healthz 200 OK");

    console.log("--- login round-trip ---");
    await loginRoundTrip(SMOKE_SERVER_PORT);

    console.log("--- stopping server/worker before uninstall ---");
    // dist-path patterns, NOT the wrapper paths: the wrappers `exec` into
    // the bundled node, so the live argv is `node .../dist/main.js` — the
    // old /opt/loombre/bin/* patterns matched NOTHING, scenario 1's
    // processes survived into the embedded scenario, and the STALE
    // external server answered /healthz on the shared port while the real
    // embedded server had died underneath it (round-5 smoke: worker
    // ECONNREFUSED on 5433 with a "passing" healthz).
    dockerExecCapture(args.containerName, ["pkill", "-f", "lib/server/dist/main.js"]);
    dockerExecCapture(args.containerName, ["pkill", "-f", "lib/worker/dist/index.js"]);
    await waitForPortFree(SMOKE_SERVER_PORT, 15_000);

    console.log("--- uninstall.sh (no --purge) ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./uninstall.sh --no-systemd`]);

    console.log("--- asserting clean uninstall (no files outside the data dir) ---");
    const opt = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /opt/loombre ] && echo EXISTS || echo GONE"]);
    const etc = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /etc/loombre ] && echo EXISTS || echo GONE"]);
    const data = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /var/lib/loombre ] && echo EXISTS || echo GONE"]);
    const shim = dockerExecCapture(args.containerName, ["bash", "-c", "[ -e /usr/local/bin/loombre ] && echo EXISTS || echo GONE"]);
    console.log(
      `smoke: /opt/loombre=${opt.stdout.trim()} /etc/loombre=${etc.stdout.trim()} /var/lib/loombre=${data.stdout.trim()} /usr/local/bin/loombre=${shim.stdout.trim()}`,
    );
    if (opt.stdout.trim() !== "GONE") throw new Error("smoke: /opt/loombre still present after uninstall");
    if (etc.stdout.trim() !== "GONE") throw new Error("smoke: /etc/loombre still present after uninstall");
    if (data.stdout.trim() !== "EXISTS") throw new Error("smoke: /var/lib/loombre (data dir) missing after a non-purge uninstall — should be preserved");
    if (shim.stdout.trim() !== "GONE") throw new Error("smoke: /usr/local/bin/loombre (PATH shim, L2) still present after uninstall");

    // ── B-5 extra scenario (a): idempotency — re-run install.sh over a ────
    //    fresh install, then again over a PRE-PLANTED STALE symlink, and
    //    assert the shim is correct after both (B-3's "stale-link upgrade
    //    path").
    console.log("\n--- extra scenario (a): idempotency — re-install over a fresh install, then over a stale symlink ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);
    assertShimResolvesUnderPrefix(args.containerName, "/opt/loombre");
    console.log("smoke: idempotency (a.1) OK — fresh re-install after a prior uninstall produced a correct shim");

    const stalePlant = dockerExecCapture(args.containerName, [
      "bash", "-c", "rm -f /usr/local/bin/loombre && ln -s /nonexistent/stale-target/loombre /usr/local/bin/loombre && readlink /usr/local/bin/loombre",
    ]);
    console.log(`smoke: planted a stale symlink -> ${stalePlant.stdout.trim()}`);
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);
    assertShimResolvesUnderPrefix(args.containerName, "/opt/loombre");
    assertCliInvocable(args.containerName);
    console.log("smoke: idempotency (a.2) OK — re-install over a stale symlink replaced it with a correct one");

    // ── B-5 extra scenario (b): foreign-file safety — a non-symlink file ──
    //    at the shim path must never be clobbered, by either script.
    console.log("\n--- extra scenario (b): foreign-file safety — a non-symlink file at the shim path must never be clobbered ---");
    dockerExecCapture(args.containerName, [
      "bash", "-c", "rm -f /usr/local/bin/loombre && printf 'not loombre — do not touch this file' > /usr/local/bin/loombre && chmod 644 /usr/local/bin/loombre",
    ]);
    const foreignBefore = dockerExecCapture(args.containerName, ["bash", "-c", "sha256sum /usr/local/bin/loombre | cut -d' ' -f1"]).stdout.trim();
    console.log(`smoke: planted a foreign (non-symlink) file at /usr/local/bin/loombre, sha256=${foreignBefore}`);

    const installOverForeign = dockerExecCapture(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);
    if (installOverForeign.status !== 0) {
      throw new Error(`smoke: install.sh must NEVER fail just because a foreign file occupies the shim path — exited ${installOverForeign.status}\n${combinedOutput(installOverForeign)}`);
    }
    const installForeignOutput = combinedOutput(installOverForeign);
    if (!installForeignOutput.includes("WARNING") || !installForeignOutput.includes("foreign file")) {
      throw new Error(`smoke: install.sh did not print the expected foreign-file WARNING:\n${installForeignOutput}`);
    }
    console.log(
      installForeignOutput
        .split("\n")
        .filter((l) => l.includes("install.sh:"))
        .map((l) => `    ${l}`)
        .join("\n"),
    );
    const foreignAfterInstall = dockerExecCapture(args.containerName, [
      "bash", "-c", "sha256sum /usr/local/bin/loombre | cut -d' ' -f1; [ -L /usr/local/bin/loombre ] && echo IS_SYMLINK || echo NOT_SYMLINK",
    ]);
    if (!foreignAfterInstall.stdout.includes(foreignBefore)) {
      throw new Error(`smoke: install.sh MODIFIED the foreign file's contents at /usr/local/bin/loombre — this must never happen (got: ${foreignAfterInstall.stdout})`);
    }
    if (!foreignAfterInstall.stdout.includes("NOT_SYMLINK")) {
      throw new Error(`smoke: install.sh replaced the foreign file with a symlink — this must never happen`);
    }
    console.log("smoke: foreign-file safety (b.1) OK — install.sh warned and left the foreign file byte-identical + untouched");

    const uninstallOverForeign = dockerExecCapture(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./uninstall.sh --no-systemd`]);
    if (uninstallOverForeign.status !== 0) {
      throw new Error(`smoke: uninstall.sh must NEVER fail just because a foreign file occupies the shim path — exited ${uninstallOverForeign.status}\n${combinedOutput(uninstallOverForeign)}`);
    }
    const uninstallForeignOutput = combinedOutput(uninstallOverForeign);
    if (!uninstallForeignOutput.includes("not a symlink") || !uninstallForeignOutput.includes("leaving it alone")) {
      throw new Error(`smoke: uninstall.sh did not print the expected foreign-file notice:\n${uninstallForeignOutput}`);
    }
    const foreignAfterUninstall = dockerExecCapture(args.containerName, [
      "bash", "-c",
      "[ -e /usr/local/bin/loombre ] && { sha256sum /usr/local/bin/loombre | cut -d' ' -f1; [ -L /usr/local/bin/loombre ] && echo IS_SYMLINK || echo NOT_SYMLINK; } || echo MISSING",
    ]);
    if (!foreignAfterUninstall.stdout.includes(foreignBefore) || !foreignAfterUninstall.stdout.includes("NOT_SYMLINK")) {
      throw new Error(`smoke: uninstall.sh did not leave the foreign file at /usr/local/bin/loombre present + untouched: ${JSON.stringify(foreignAfterUninstall.stdout)}`);
    }
    console.log("smoke: foreign-file safety (b.2) OK — uninstall.sh left the foreign file present + byte-identical + untouched");

    dockerExecCapture(args.containerName, ["bash", "-c", "rm -f /usr/local/bin/loombre"]);
    console.log("smoke: cleaned up the planted foreign file");

    // ── EMBEDDED-MODE scenario (installer completeness audit, gap 6): the ──
    //    out-of-the-box path an operator gets by NOT setting DATABASE_URL.
    //    Before the audit this smoke only ever proved external-PG, while
    //    the wrapper's default path (embedded provision + boot-time
    //    auto-migrate via @loombre/db/migrate shipping in the deploy) went
    //    completely unexercised — and the web client had NO scenario at
    //    all because nothing in the tarball could even start it.
    //
    //    NO DATABASE_URL is exported anywhere below — safe by construction
    //    (see the header's RESOURCE ISOLATION note): LOOMBRE_DATA_DIR is
    //    set, so server AND worker resolve the container-local embedded
    //    cluster; the shared-dev-PG fallback needs LOOMBRE_DATA_DIR unset.
    //
    //    User note (mission-checked): embedded initdb REFUSES to run as
    //    root. This container's `docker exec` default IS root (plain
    //    ubuntu:24.04), so every process below runs `-u loombre` — the
    //    same unprivileged system user install.sh created, which owns
    //    /var/lib/loombre. (`runuser`/`su` would work too; `docker exec -u`
    //    is the same thing with less quoting.)
    console.log("\n--- embedded-mode scenario: re-install, boot server+web+worker with NO DATABASE_URL ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);

    run("docker", [
      "exec", "-d", "-u", "loombre",
      "-e", `PORT=${SMOKE_SERVER_PORT}`, "-e", "NODE_ENV=production", "-e", "LOOMBRE_DATA_DIR=/var/lib/loombre",
      args.containerName, "bash", "-c", "/opt/loombre/bin/loombre-server > /tmp/loombre-server-embedded.log 2>&1",
    ]);

    console.log("--- waiting for /healthz (embedded provision: initdb + start + AUTO-MIGRATE — slower than external) ---");
    try {
      // 120s, not the external scenario's 30s: first boot runs a real
      // initdb + cluster start + full migration set before listening.
      await waitForHealthz(SMOKE_SERVER_PORT, 120_000);
    } catch (err) {
      console.error("--- embedded /healthz never came up — dumping in-container log for diagnosis ---");
      dockerExec(args.containerName, ["bash", "-c", "cat /tmp/loombre-server-embedded.log 2>&1"], { allowFailure: true });
      throw err;
    }
    console.log("smoke: embedded-mode /healthz 200 OK — provision + auto-migrate fully self-contained (no repo checkout, no external DB)");

    console.log("--- web client via bin/loombre-web ---");
    // LOOMBRE_DATA_DIR, like the server/worker launches above and like the
    // systemd unit's EnvironmentFile: the wrapper cd's there before teeing
    // its log to logs/web.log — without it the cwd is `/` and the mkdir
    // fails as the service user before Next ever starts.
    run("docker", [
      "exec", "-d", "-u", "loombre",
      "-e", `LOOMBRE_WEB_PORT=${SMOKE_WEB_PORT}`, "-e", `LOOMBRE_SERVER_ORIGIN=http://localhost:${SMOKE_SERVER_PORT}`, "-e", "LOOMBRE_DATA_DIR=/var/lib/loombre",
      args.containerName, "bash", "-c", "/opt/loombre/bin/loombre-web > /tmp/loombre-web.log 2>&1",
    ]);
    try {
      await waitForHttp200(`http://127.0.0.1:${SMOKE_WEB_PORT}/login`, 60_000);
    } catch (err) {
      console.error("--- web /login never came up — dumping in-container log for diagnosis ---");
      dockerExec(args.containerName, ["bash", "-c", "cat /tmp/loombre-web.log 2>&1"], { allowFailure: true });
      throw err;
    }
    console.log("smoke: web client serves /login 200 via bin/loombre-web (Next standalone + bundled node)");

    console.log("--- worker: embedded DATABASE_URL discovery via LOOMBRE_DATA_DIR ---");
    run("docker", [
      "exec", "-d", "-u", "loombre",
      "-e", "NODE_ENV=production", "-e", "LOOMBRE_DATA_DIR=/var/lib/loombre",
      args.containerName, "bash", "-c", "/opt/loombre/bin/loombre-worker > /tmp/loombre-worker-embedded.log 2>&1",
    ]);
    // "worker up — plugin-delivery loop started" is index.ts's own
    // end-of-boot line — it only prints after the discovery seam resolved
    // the embedded URL and the queue connected, so matching it proves the
    // worker JOINED, not merely that the process is still alive.
    await waitForContainerLogLine(args.containerName, "/tmp/loombre-worker-embedded.log", "worker up", 90_000);
    // Pattern note: the wrapper `exec`s the bundled node, so the live
    // process's argv is `.../runtime/node/bin/node .../lib/worker/dist/index.js`
    // — match the dist path, not the wrapper path (which exists in no argv
    // after the exec).
    const workerAlive = dockerExecCapture(args.containerName, ["bash", "-c", "pgrep -f lib/worker/dist/index.js >/dev/null && echo ALIVE || echo DEAD"]);
    if (!workerAlive.stdout.includes("ALIVE")) {
      throw new Error("smoke: worker logged its boot line but the process is no longer running");
    }
    console.log("smoke: worker joined via embedded discovery (logged 'worker up', process alive)");

    console.log("--- embedded scenario teardown ---");
    dockerExecCapture(args.containerName, ["pkill", "-f", "lib/worker/dist/index.js"]);
    dockerExecCapture(args.containerName, ["pkill", "-f", "web/apps/web/server.js"]);
    dockerExecCapture(args.containerName, ["pkill", "-f", "lib/server/dist/main.js"]);
    console.log("smoke: embedded-mode scenario PASSED — server (provision+auto-migrate), web (/login 200), worker (discovery join), zero DATABASE_URL");

    console.log("\n=== smoke: ALL CHECKS PASSED ===");
  } finally {
    if (!args.keepContainer) {
      removeContainerIfExists(args.containerName);
      console.log(`smoke: removed container ${args.containerName}`);
    } else {
      console.log(`smoke: --keep-container passed — leaving ${args.containerName} running for inspection`);
    }
  }
}

const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntrypoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
