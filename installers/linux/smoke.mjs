#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/smoke.mjs
//
// The REAL check for the Linux tarball + systemd distribution channel
// (P4.1). Inside a fresh ubuntu:24.04 container: extracts the built
// tarball, runs install.sh --no-systemd, boots server+worker with the
// BUNDLED node against the loombre_i1 database (external-PG path — P4.2;
// embedded PG is lane B's), asserts /healthz 200 and a real login
// round-trip via the seeded admin, then asserts a clean (non-purge)
// uninstall leaves NO FILES OUTSIDE THE DATA DIR.
//
// RESOURCE ISOLATION (this lane's dispatch): ports 3100-3199, database
// `loombre_i1` on the shared dev Postgres (127.0.0.1:5442) — NEVER the
// `loombre` database (that is another lane's / the base dev environment's,
// off-limits). Every DATABASE_URL this script builds is asserted to
// target `loombre_i1` before use — see assertSafeDatabaseUrl below. This
// assertion exists because an earlier session mistake (documented in the
// I1 handoff report) booted a real app process with no DATABASE_URL
// override at all, which would have defaulted straight at the shared
// `loombre` database — never again silently.
//
// Wires into NOTHING (ci.yml untouched — release wiring is lane I's).
//
// Usage:
//   node installers/linux/smoke.mjs [--tarball <path>] [--keep-container]
//                                    [--container-name <name>]
//
// Prerequisites: docker running locally; the shared dev Postgres
// container up (`docker compose -f docker-compose.dev.yml up -d`,
// 127.0.0.1:5442, user/password `loombre`) — this script does NOT start
// it, only connects to it.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  const out = { tarball: null, keepContainer: false, containerName: "loombre_i1-smoke" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball") out.tarball = resolve(argv[++i]);
    else if (arg === "--keep-container") out.keepContainer = true;
    else if (arg === "--container-name") out.containerName = argv[++i];
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

function ensureTarball(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`smoke: --tarball ${explicitPath} does not exist`);
    return explicitPath;
  }
  const suffix = `-linux-${TARBALL_ARCH}.tar.gz`;
  const distDir = join(INSTALLERS_LINUX_DIR, "dist");
  if (existsSync(distDir)) {
    const existing = readdirSync(distDir).filter((f) => f.endsWith(suffix));
    if (existing.length > 0) {
      const path = join(distDir, existing.sort().at(-1));
      console.log(`smoke: reusing existing tarball ${path}`);
      return path;
    }
  }
  console.log("smoke: no tarball found — building one now (node installers/linux/build-tarball.mjs)");
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

async function waitForHealthz(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return true;
      lastErr = new Error(`GET /healthz -> HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`smoke: /healthz never returned 200 within ${timeoutMs}ms — last error: ${lastErr?.message ?? lastErr}`);
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

  const tarballPath = ensureTarball(args.tarball);
  const tarballName = tarballPath.split("/").at(-1).replace(/\.tar\.gz$/, "");
  console.log(`\n=== smoke: ${tarballName} ===\n`);

  removeContainerIfExists(args.containerName);
  try {
    console.log("--- starting container ---");
    run("docker", [
      "run", "-d", "--name", args.containerName,
      "--add-host=host.docker.internal:host-gateway",
      "-p", `${SMOKE_SERVER_PORT}:${SMOKE_SERVER_PORT}`,
      "ubuntu:24.04", "sleep", "infinity",
    ]);

    console.log("--- copying + extracting tarball ---");
    run("docker", ["cp", tarballPath, `${args.containerName}:/tmp/${tarballName}.tar.gz`]);
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp && tar xzf ${tarballName}.tar.gz`]);

    console.log("--- install.sh --no-systemd ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./install.sh --no-systemd`]);

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
    dockerExecCapture(args.containerName, ["pkill", "-f", "/opt/loombre/bin/loombre-server"]);
    dockerExecCapture(args.containerName, ["pkill", "-f", "/opt/loombre/bin/loombre-worker"]);

    console.log("--- uninstall.sh (no --purge) ---");
    dockerExec(args.containerName, ["bash", "-c", `cd /tmp/${tarballName} && ./uninstall.sh --no-systemd`]);

    console.log("--- asserting clean uninstall (no files outside the data dir) ---");
    const opt = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /opt/loombre ] && echo EXISTS || echo GONE"]);
    const etc = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /etc/loombre ] && echo EXISTS || echo GONE"]);
    const data = dockerExecCapture(args.containerName, ["bash", "-c", "[ -d /var/lib/loombre ] && echo EXISTS || echo GONE"]);
    console.log(`smoke: /opt/loombre=${opt.stdout.trim()} /etc/loombre=${etc.stdout.trim()} /var/lib/loombre=${data.stdout.trim()}`);
    if (opt.stdout.trim() !== "GONE") throw new Error("smoke: /opt/loombre still present after uninstall");
    if (etc.stdout.trim() !== "GONE") throw new Error("smoke: /etc/loombre still present after uninstall");
    if (data.stdout.trim() !== "EXISTS") throw new Error("smoke: /var/lib/loombre (data dir) missing after a non-purge uninstall — should be preserved");

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
