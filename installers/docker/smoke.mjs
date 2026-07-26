#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/docker/smoke.mjs
//
// Automated end-to-end smoke test for the Docker distribution (STATE.md
// P4.1/P4.12, lane I2 deliverable 4). Builds the image from CURRENT repo
// source, brings up the full docker-compose.prod.yml stack under a
// dedicated compose project (never the default project — resource
// isolation), runs the real migration + seed one-shot the same way an
// operator would, exercises a real login + catalog request over HTTP, then
// proves the worker container shuts down cleanly on SIGTERM before tearing
// everything down.
//
// Resource isolation (this lane's brief): compose project `loombre_i2`,
// host port 3200-3299 range only (default 3201, override with
// LOOMBRE_SMOKE_PORT), never touches the `loombre` dev DB or ports 3000/3001.
//
// Usage: node installers/docker/smoke.mjs
// Exit code 0 = all assertions passed and cleanup completed. Non-zero =
// something failed; `docker compose ... down -v` still runs (best-effort)
// via the top-level finally block either way.

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.prod.yml");
const PROJECT = "loombre_i2";
const HOST_PORT = process.env.LOOMBRE_SMOKE_PORT ?? "3201";
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

const SMOKE_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  POSTGRES_DB: "loombre",
  POSTGRES_USER: "loombre",
  POSTGRES_PASSWORD: "loombre-i2-smoke-password",
  LOOMBRE_JWT_SECRET: "loombre-i2-smoke-jwt-secret-not-for-production",
  LOOMBRE_PORT: HOST_PORT,
};

let stepNum = 0;
function step(label) {
  stepNum += 1;
  console.log(`\n[smoke ${stepNum}] ${label}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok: ${message}`);
}

function compose(args, { capture = false, allowFail = false } = {}) {
  const result = spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    env: SMOKE_ENV,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (exit ${result.status})` +
        (capture ? `\nstdout: ${result.stdout}\nstderr: ${result.stderr}` : ""),
    );
  }
  return result;
}

function dockerInspect(containerId, format) {
  const result = spawnSync("docker", ["inspect", "-f", format, containerId], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function containerIdFor(service) {
  const result = compose(["ps", "-q", service], { capture: true });
  const id = result.stdout.trim();
  return id.length > 0 ? id : null;
}

async function waitForHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = containerIdFor(service);
    if (id) {
      const status = dockerInspect(id, "{{.State.Health.Status}}");
      if (status === "healthy") return;
      if (status === "unhealthy") {
        const logs = spawnSync("docker", ["logs", "--tail", "80", id], { encoding: "utf8" });
        throw new Error(`${service} reported unhealthy. Recent logs:\n${logs.stdout}\n${logs.stderr}`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`${service} did not become healthy within ${timeoutMs}ms`);
    }
    await delay(1000);
  }
}

async function waitForExit(containerId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = dockerInspect(containerId, "{{.State.Status}}");
    if (status === "exited") return;
    if (Date.now() > deadline) {
      throw new Error(`container ${containerId} did not exit within ${timeoutMs}ms (last status: ${status})`);
    }
    await delay(500);
  }
}

function buildDeviceProfile() {
  // Mirrors apps/server/test/auth.e2e.spec.ts's buildDeviceProfile() —
  // the minimal valid DeviceProfile shape POST /auth/login requires.
  return {
    profileId: "docker-smoke",
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

async function main() {
  step(`build (project=${PROJECT}, host port=${HOST_PORT})`);
  compose(["build"]);

  step("up -d (postgres, server, worker)");
  compose(["up", "-d"]);

  step("wait for postgres healthy");
  await waitForHealthy("postgres", 60_000);
  console.log("  postgres is healthy");

  step("wait for server healthy (HEALTHCHECK: GET /healthz)");
  await waitForHealthy("server", 60_000);
  console.log("  server is healthy");

  step("run migrations inside the network (docker compose run --rm server) — this is also the documented upgrade step, see docs/install/docker.md");
  compose(["run", "--rm", "server", "node", "packages/db/scripts/migrate.mjs", "migrate"]);

  step("seed deterministic dev/smoke data (docker compose run --rm server)");
  compose(["run", "--rm", "server", "node", "packages/db/seed/seed.mjs"]);

  step("login round-trip: POST /auth/login with the seed admin's real credentials");
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "docker-smoke-device",
      deviceProfile: buildDeviceProfile(),
    }),
  });
  assert(loginRes.status === 200, `POST /auth/login -> 200 (got ${loginRes.status})`);
  const loginBody = await loginRes.json();
  assert(typeof loginBody.accessToken === "string" && loginBody.accessToken.length > 0, "response has a non-empty accessToken");
  const accessToken = loginBody.accessToken;

  step("catalog request: GET /libraries with the access token");
  const libRes = await fetch(`${BASE_URL}/libraries`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert(libRes.status === 200, `GET /libraries -> 200 (got ${libRes.status})`);
  const libBody = await libRes.json();
  assert(Array.isArray(libBody.items), "response body has an items array (LibraryPage shape)");
  console.log(`  ${libBody.items.length} libraries visible to the seed admin`);

  step("SIGTERM the worker container (docker compose stop) and assert clean shutdown");
  const workerId = containerIdFor("worker");
  assert(workerId !== null, "worker container is running before stop");
  compose(["stop", "--timeout", "15", "worker"]);
  await waitForExit(workerId, 20_000);
  const exitCode = dockerInspect(workerId, "{{.State.ExitCode}}");
  assert(exitCode === "0", `worker container exited 0 (got ${exitCode})`);
  const workerLogs = spawnSync("docker", ["logs", workerId], { encoding: "utf8" });
  const combinedLogs = `${workerLogs.stdout}\n${workerLogs.stderr}`;
  assert(
    combinedLogs.includes("worker: received SIGTERM, shutting down"),
    'worker logged "worker: received SIGTERM, shutting down" (apps/worker/src/index.ts shutdown())',
  );

  console.log("\n[smoke] ALL CHECKS PASSED");
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error(`\n[smoke] FAILED: ${err instanceof Error ? err.message : err}`);
  console.error("[smoke] recent logs from all services:");
  compose(["logs", "--tail", "100"], { allowFail: true });
} finally {
  step("cleanup: docker compose down -v");
  compose(["down", "-v"], { allowFail: true });
}

process.exit(exitCode);
