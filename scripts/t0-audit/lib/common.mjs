#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/lib/common.mjs
//
// Shared helpers for the Phase 4 Wave 3 / deliverable H (physical Tier-0
// audit) scripts under scripts/t0-audit/**. NOT part of any app/package —
// this directory is excluded from dependency-cruiser's graph (its
// `includeOnly` is scoped to `^(apps|packages)/`, same as scripts/perf-t0.mjs
// and packages/db/seed/seed-large.mjs already rely on), so these files are
// free to import `@loombre/db` (for the guarded playback-session read used
// by sustained-monitor.mjs — CLAUDE.md invariant 4 is about catalog reads
// through packages/db/query, which this satisfies rather than bypasses) and
// plain Node builtins.
//
// These scripts are written to run for real ONLY on the owner's physical
// N100 (Linux, systemd, real QSV hardware) — this repo's CI/dev hosts (this
// M3 Max included) cannot execute the hardware-dependent paths (RSS of real
// systemd units, /dev/dri, embedded-PG data dirs). Every file is still
// `node --check`-clean and its pure-logic pieces (arg parsing, table
// formatting, threshold comparison) are exercised by hand against fixtures
// during review — see docs/ops/t0-audit-runbook.md's "Verifying these
// scripts without an N100" section for exactly what was checked where.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Defaults matching installers/linux/install.sh + docs/install/linux.md
// ---------------------------------------------------------------------------

export const DEFAULT_PREFIX = "/opt/loombre";
export const DEFAULT_DATA_DIR = "/var/lib/loombre";
export const DEFAULT_CONFIG_DIR = "/etc/loombre";
export const DEFAULT_PORT = 3001;
// packages/db/seed/seed.mjs's fixed seeded admin (the documented bootstrap
// path for THIS audit — docs/install/linux.md step 4 already tells every
// operator to run `pnpm db:seed` against their DATABASE_URL; this audit
// reuses that same seeded identity rather than inventing a second one).
export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "loombre-seed-admin";

export function log(tag, ...args) {
  console.log(`[t0-audit:${tag}]`, ...args);
}

export function warn(tag, ...args) {
  console.warn(`[t0-audit:${tag}] WARN`, ...args);
}

export function fail(tag, ...args) {
  console.error(`[t0-audit:${tag}] FAIL`, ...args);
}

// ---------------------------------------------------------------------------
// CLI arg parsing (tiny, dependency-free — matches scripts/perf-t0.mjs's
// own "no CLI-parsing library" convention)
// ---------------------------------------------------------------------------

/** Parses `--key value` / `--key=value` / `--flag` pairs into an object.
 *  Bare `--flag` (no following value, or followed by another `--flag`)
 *  becomes `true`. Positional (non `--`) args are collected under `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const bare = arg.slice(2);
    const eqIdx = bare.indexOf("=");
    if (eqIdx !== -1) {
      out[bare.slice(0, eqIdx)] = bare.slice(eqIdx + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[bare] = next;
      i += 1;
    } else {
      out[bare] = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// loombre.env reading (so scripts can discover LOOMBRE_DATA_DIR / the
// LOOMBRE_EMBEDDED_PG_VENDOR_DIR the owner set, without re-parsing bash)
// ---------------------------------------------------------------------------

/** Parses a systemd-EnvironmentFile-shaped file (`KEY=value` per line,
 *  `#`-comments, blank lines) into a plain object. Missing file -> {}. */
export function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip a single layer of matching quotes, same as EnvironmentFile=.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Resolves the real install's env file (`--config-dir`/`LOOMBRE_CONFIG_DIR`
 *  override, else the installer default) and merges it under `process.env`
 *  (process.env wins — an explicit shell export always overrides the file,
 *  matching how systemd's EnvironmentFile= + the unit's own Environment=
 *  would layer, and letting a one-off `FOO=bar node script.mjs` override
 *  without editing the file). */
export function resolveInstallEnv(args) {
  const configDir = args["config-dir"] ?? process.env["LOOMBRE_CONFIG_DIR"] ?? DEFAULT_CONFIG_DIR;
  const fileEnv = readEnvFile(path.join(configDir, "loombre.env"));
  return { ...fileEnv, ...process.env };
}

export function resolveDataDir(env) {
  return env["LOOMBRE_DATA_DIR"] ?? DEFAULT_DATA_DIR;
}

export function resolvePrefix(args) {
  return args["prefix"] ?? DEFAULT_PREFIX;
}

export function resolvePort(env) {
  const raw = env["PORT"];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Process / RSS inspection (Linux-targeted — ps -o rss=, systemctl,
// pgrep/pkill). These all degrade to a clear thrown error rather than a
// silent NaN when run on a non-Linux host or without the binary present,
// since a wrong-but-quiet number is worse than a loud failure in an audit
// script (CLAUDE.md: "no fabricated measurements").
// ---------------------------------------------------------------------------

export function isLinux() {
  return platform() === "linux";
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function requireCommand(cmd) {
  const which = run("sh", ["-c", `command -v ${cmd}`]);
  if (which.status !== 0) {
    throw new Error(
      `t0-audit: required command '${cmd}' not found on PATH — this script is Linux/N100-targeted ` +
        "(see docs/ops/t0-audit-runbook.md's 'N100-only vs locally-verified' section).",
    );
  }
}

/** systemd MainPID for a unit, or null if inactive/not found. Since every
 *  systemd unit here is `Type=simple` + the bin/ wrapper `exec`s straight
 *  into node (installers/linux/build-tarball.mjs's writeWrapperScripts),
 *  MainPID IS the Node process's own pid — no extra hop needed. */
export function systemdMainPid(unit) {
  requireCommand("systemctl");
  const result = run("systemctl", ["show", unit, "--property=MainPID", "--value"]);
  if (result.status !== 0) return null;
  const pid = Number.parseInt((result.stdout ?? "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function systemdActiveState(unit) {
  requireCommand("systemctl");
  const result = run("systemctl", ["show", unit, "--property=ActiveState", "--value"]);
  return (result.stdout ?? "").trim() || "unknown";
}

/** RSS (bytes) for one pid via `ps -o rss=`. NaN if the pid is gone. */
export function rssBytesForPid(pid) {
  const result = run("ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = Number.parseInt((result.stdout ?? "").trim(), 10);
  return Number.isFinite(kb) ? kb * 1024 : NaN;
}

/** Direct child pids of `ppid` (postgres's background workers — checkpointer,
 *  bgwriter, walwriter, autovacuum launcher, logical-replication launcher —
 *  are all direct children of the postmaster, never grandchildren, under
 *  normal operation). */
export function directChildPids(ppid) {
  requireCommand("pgrep");
  const result = run("pgrep", ["-P", String(ppid)]);
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Finds the embedded-PostgreSQL postmaster pid by matching `-D <pgDataDir>`
 * in a process's own argv (via `pgrep -f`). This is reliable specifically
 * for the MASTER postgres process: PostgreSQL rewrites each of its OWN
 * child processes' argv/cmdline in place (`update_process_title`, on by
 * default on Linux) to "postgres: checkpointer" etc., which drops the
 * original `-D ...` text from THEIR cmdline — but the master's own cmdline
 * memory is what `pgrep -f` matches here, and nothing rewrites that.
 * Returns null if no match (PG not running, or not embedded-mode).
 */
export function findEmbeddedPgMasterPid(pgDataDir) {
  requireCommand("pgrep");
  const result = run("pgrep", ["-f", `-D ${pgDataDir}`]);
  if (result.status !== 0) return null;
  const pids = (result.stdout ?? "")
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  // pgrep -f can also match the pg_ctl/exec chain transiently; take the
  // lowest pid as the most-likely-master heuristic is fragile — instead
  // verify via `ps -o comm=` that this pid's command is literally
  // "postgres" (the master's own process name), not some wrapper.
  for (const pid of pids) {
    const comm = run("ps", ["-o", "comm=", "-p", String(pid)]);
    if ((comm.stdout ?? "").trim() === "postgres") return pid;
  }
  return pids[0] ?? null;
}

/** Sums RSS (bytes) for the embedded-PG postmaster + all its direct
 *  children ("the embedded PostgreSQL process family"'s memory footprint).
 *  Returns {totalBytes, pidCount} or null if PG isn't running/found. */
export function embeddedPgRssBytes(pgDataDir) {
  const masterPid = findEmbeddedPgMasterPid(pgDataDir);
  if (masterPid === null) return null;
  const pids = [masterPid, ...directChildPids(masterPid)];
  let total = 0;
  let counted = 0;
  for (const pid of pids) {
    const bytes = rssBytesForPid(pid);
    if (Number.isFinite(bytes)) {
      total += bytes;
      counted += 1;
    }
  }
  return { totalBytes: total, pidCount: counted, masterPid };
}

/** Every currently-running ffmpeg pid (`pgrep -x ffmpeg`). apps/worker's
 *  transcode runner (src/transcode/process.ts's spawnFfmpegRun) execs the
 *  resolved ffmpeg binary directly — `comm` is exactly "ffmpeg" (short
 *  enough it is never truncated by the kernel's 15-char TASK_COMM_LEN). */
export function allFfmpegPids() {
  requireCommand("pgrep");
  const result = run("pgrep", ["-x", "ffmpeg"]);
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Identifies which running ffmpeg pid (if any) belongs to a given
 * transcode session, by matching /proc/<pid>/cwd against the session's run
 * directory — apps/worker/src/transcode/runner.ts spawns ffmpeg with
 * `cwd: runDir` (a subdirectory of the session's `stagingDir` row value,
 * `staging.ts`'s `runDirFor`/`createRunDir`), and ffmpeg's own argv uses
 * relative output filenames resolved against that cwd — so argv text
 * matching (`pgrep -f <stagingDir>`) is NOT reliable here, but the process's
 * actual working directory always is. Requires read access to
 * /proc/<pid>/cwd for another user's process (root, or running as the same
 * `loombre` user) — see the runbook's "run as root" note.
 *
 * Returns {pid, runDir} or null if no running ffmpeg currently has its cwd
 * under this session's staging dir (e.g. between runs, or throttle-suspended
 * — SIGSTOP does NOT change cwd, so a suspended ffmpeg is still found here).
 */
export function findFfmpegPidForSessionDir(sessionStagingDir) {
  if (!sessionStagingDir) return null;
  const prefix = sessionStagingDir.endsWith(path.sep) ? sessionStagingDir : sessionStagingDir + path.sep;
  for (const pid of allFfmpegPids()) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === sessionStagingDir || cwd.startsWith(prefix)) {
        return { pid, runDir: cwd };
      }
    } catch {
      // process exited between pgrep and readlink, or /proc/<pid>/cwd is
      // unreadable (permissions) — skip, it's not a match we can use.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thermal / throttle best-effort reading (generic Linux sysfs — no
// vendor-specific tool required; degrades to "unavailable" rather than
// guessing).
// ---------------------------------------------------------------------------

/** Reads every /sys/class/thermal/thermal_zoneN/temp (millidegrees C),
 *  paired with its `type` file. Returns [] if the hierarchy doesn't exist
 *  (e.g. run inside a container without the host's thermal sysfs mounted,
 *  or non-Linux). Values are millidegrees per the kernel ABI; callers
 *  divide by 1000 for °C. */
export function readThermalZones() {
  const base = "/sys/class/thermal";
  if (!existsSync(base)) return [];
  const zones = [];
  let entries;
  try {
    entries = run("sh", ["-c", `ls -d ${base}/thermal_zone* 2>/dev/null`]).stdout
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  for (const zoneDir of entries) {
    try {
      const type = readFileSync(path.join(zoneDir, "type"), "utf8").trim();
      const tempMilliC = Number.parseInt(readFileSync(path.join(zoneDir, "temp"), "utf8").trim(), 10);
      if (Number.isFinite(tempMilliC)) zones.push({ zone: path.basename(zoneDir), type, tempMilliC });
    } catch {
      // unreadable zone (permissions, race with hot-unplug) — skip it,
      // don't fail the whole sample over one zone.
    }
  }
  return zones;
}

/** Best-effort "is the CPU currently throttled below its rated max
 *  frequency" signal: compares each core's scaling_cur_freq against its own
 *  cpuinfo_max_freq. NOT conclusive alone (a merely-idle core also reads
 *  low) — sustained-monitor.mjs uses this as a supporting signal alongside
 *  dmesg thermal/throttle log lines, never as the sole verdict. */
export function readCpuFreqSample() {
  const base = "/sys/devices/system/cpu";
  if (!existsSync(base)) return [];
  const dirs = run("sh", ["-c", `ls -d ${base}/cpu[0-9]* 2>/dev/null`]).stdout
    .split("\n")
    .filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    try {
      const curKHz = Number.parseInt(
        readFileSync(path.join(dir, "cpufreq", "scaling_cur_freq"), "utf8").trim(),
        10,
      );
      const maxKHz = Number.parseInt(
        readFileSync(path.join(dir, "cpufreq", "cpuinfo_max_freq"), "utf8").trim(),
        10,
      );
      if (Number.isFinite(curKHz) && Number.isFinite(maxKHz)) {
        out.push({ cpu: path.basename(dir), curKHz, maxKHz });
      }
    } catch {
      // cpufreq not exposed for this core (or at all) — skip.
    }
  }
  return out;
}

/** dmesg lines mentioning thermal throttling since boot — the most
 *  authoritative signal when readable (`dmesg` is root-only on many
 *  distros' default `kernel.dmesg_restrict=1`; failures are reported, not
 *  silently swallowed, since "we couldn't check" and "we checked and it's
 *  clean" are very different findings for an audit). */
export function readDmesgThrottleLines() {
  const result = run("sh", ["-c", "dmesg -T 2>&1 | grep -iE 'thermal|throttl' || true"]);
  if (result.status !== 0 && !(result.stdout ?? "").length) {
    return { available: false, lines: [], note: (result.stderr ?? "").trim() || "dmesg unavailable" };
  }
  const lines = (result.stdout ?? "").split("\n").filter(Boolean);
  return { available: true, lines, note: null };
}

// ---------------------------------------------------------------------------
// HTTP / auth against a running Loombre server (no `/v1` prefix — see
// scripts/perf-t0.mjs, which already hits these same bare paths)
// ---------------------------------------------------------------------------

export async function apiFetch(baseUrl, accessToken, requestPath, init = {}) {
  const res = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export async function apiFetchJson(baseUrl, accessToken, requestPath, init = {}) {
  const res = await apiFetch(baseUrl, accessToken, requestPath, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${requestPath} -> HTTP ${res.status}: ${body.slice(0, 800)}`);
  }
  return res.json();
}

/** Minimal DeviceProfile identical in shape to scripts/perf-t0.mjs's own
 *  buildDeviceProfile — a real Chrome-shaped profile capable of direct-play,
 *  used for login and read-path measurements where forcing transcode is NOT
 *  the goal. dual-transcode.mjs uses a DIFFERENT, deliberately-restrictive
 *  profile (see that file) to force decision==='transcode'. */
export function buildPermissiveDeviceProfile() {
  return {
    profileId: "t0-audit-harness",
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

export async function login(baseUrl, username, password, deviceName, deviceProfile) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      deviceName,
      deviceProfile: deviceProfile ?? buildPermissiveDeviceProfile(),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`login failed -> HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const pair = await res.json();
  const me = await apiFetchJson(baseUrl, pair.accessToken, "/users/me");
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, deviceId: pair.deviceId, userId: me.id };
}

/** Rotates a refresh token for a new TokenPair (POST /auth/refresh). The
 *  returned refreshToken REPLACES the one passed in — refresh tokens are
 *  single-use/rotating (STATE.md P2.1 reuse-detection) — callers holding a
 *  long-running session (sustained-monitor.mjs's 30-minute loop, well
 *  past the 15-minute access-token TTL) must always keep the LATEST
 *  refreshToken this returns, never reuse an older one. */
export async function refreshAccessToken(baseUrl, refreshToken, deviceId) {
  const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken, deviceId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token refresh failed -> HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const pair = await res.json();
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
}

export async function waitForHealthz(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(
    `${baseUrl}/healthz did not return 200 within ${timeoutMs}ms` +
      (lastError ? `: ${lastError.message}` : ""),
  );
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fmtMiB(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function writeJsonResult(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

/** The results directory every t0-audit script writes its JSON artifact
 *  into, read back by collect-report.mjs. Overridable so a single audit run
 *  can be kept alongside its evidence under a dated directory. */
export function resultsDir(args) {
  return args["results-dir"] ?? process.env["T0_AUDIT_RESULTS_DIR"] ?? path.join(process.cwd(), "t0-audit-results");
}
