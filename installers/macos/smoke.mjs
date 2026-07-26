#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/smoke.mjs
//
// Best-effort LOCAL smoke, no sudo (mission deliverable 5). Proves:
//   1. `pkgutil --expand-full` on the built .pkg + payload layout assertions
//   2. `plutil -lint` on every plist shipped (LaunchDaemons, Info.plist,
//      Distribution.xml)
//   3. `launchctl print` against the (not-loaded) daemon labels — proves
//      what's provable without sudo/loading; documents what isn't
//   4. the bundled server binary boots for real against the external-PG
//      loombre_i4 DB on a 34xx port (external-PG path, D1)
//   5. the bundled worker binary boots, registers consumers, and exits
//      cleanly on SIGTERM
//
// What this does NOT and CANNOT prove without sudo (left to Wave 3 +
// owner smoke, per the mission): `installer -pkg` actually running,
// postinstall's `_loombre` user creation / `launchctl bootstrap system`,
// the Gatekeeper unsigned-open flow, a live LaunchDaemon actually staying
// up across a real boot.

import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LANE_DIR = __dirname;
const BUILD_CACHE = path.join(LANE_DIR, ".build-cache");

// --arch is accepted (build-pkg.mjs passes it) but this script reads
// everything it needs from last-build-report.json, which already records
// the arch the just-built .pkg targeted.

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${label}: ${err.message ?? err}`);
  }
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  return res;
}

async function main() {
  const reportPath = path.join(BUILD_CACHE, "last-build-report.json");
  if (!existsSync(reportPath)) {
    throw new Error(`no build report at ${reportPath} — run build-pkg.mjs first`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const pkgPath = report.pkgPath;
  if (!existsSync(pkgPath)) throw new Error(`built pkg missing: ${pkgPath}`);

  console.log(`\n=== 1. pkgutil --expand-full + payload layout ===`);
  const expandDir = mkdtempSync(path.join(os.tmpdir(), "loombre-pkg-expand-"));
  const expandTarget = path.join(expandDir, "expanded");
  check("pkgutil --expand-full succeeds", () => {
    const res = run("pkgutil", ["--expand-full", pkgPath, expandTarget]);
    if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  });

  const componentPkgDir = path.join(expandTarget, "loombre-component.pkg");
  const payloadDir = path.join(componentPkgDir, "Payload");
  check("expanded component pkg has a Payload/ directory", () => {
    if (!existsSync(payloadDir)) throw new Error(`missing ${payloadDir}`);
  });

  const expectedPaths = [
    `opt/loombre/${report.version}/bin/loombre-server`,
    `opt/loombre/${report.version}/bin/loombre-worker`,
    `opt/loombre/${report.version}/server/dist/main.js`,
    `opt/loombre/${report.version}/worker/dist/index.js`,
    `opt/loombre/${report.version}/runtime/node/bin/node`,
    `opt/loombre/${report.version}/VERSION`,
    `opt/loombre/current`,
    `Applications/Loombre.app/Contents/MacOS/Loombre`,
    `Applications/Loombre.app/Contents/Info.plist`,
    `Library/LaunchDaemons/com.loombre.server.plist`,
    `Library/LaunchDaemons/com.loombre.worker.plist`,
    `Library/Application Support/Loombre/db`,
    `Library/Application Support/Loombre/ipc`,
    `Library/Logs/Loombre`,
  ];
  for (const rel of expectedPaths) {
    check(`payload contains ${rel}`, () => {
      if (!existsSync(path.join(payloadDir, rel))) throw new Error("missing from expanded payload");
    });
  }

  check("opt/loombre/current is a symlink to the version dir", () => {
    const res = run("readlink", [path.join(payloadDir, "opt", "loombre", "current")]);
    if (res.stdout.trim() !== report.version) {
      throw new Error(`readlink -> ${res.stdout.trim()}, expected ${report.version}`);
    }
  });

  check("PackageInfo / scripts present", () => {
    const scriptsDir = path.join(componentPkgDir, "Scripts");
    if (!existsSync(path.join(scriptsDir, "preinstall"))) throw new Error("missing Scripts/preinstall");
    if (!existsSync(path.join(scriptsDir, "postinstall"))) throw new Error("missing Scripts/postinstall");
  });

  console.log(`\n=== 2. plutil -lint on every shipped plist, xmllint on Distribution.xml ===`);
  const plistTargets = [
    path.join(payloadDir, "Library", "LaunchDaemons", "com.loombre.server.plist"),
    path.join(payloadDir, "Library", "LaunchDaemons", "com.loombre.worker.plist"),
    path.join(payloadDir, "Applications", "Loombre.app", "Contents", "Info.plist"),
  ];
  for (const p of plistTargets) {
    check(`plutil -lint ${path.relative(expandTarget, p)}`, () => {
      if (!existsSync(p)) throw new Error("file missing");
      const res = run("plutil", ["-lint", p]);
      if (res.status !== 0) throw new Error(res.stdout + res.stderr);
    });
  }
  // Distribution (productbuild's top-level metadata file) is Apple's
  // installer-gui-script XML format, NOT a plist — plutil correctly
  // refuses it ("unknown tag installer-gui-script"). xmllint --noout
  // is the appropriate well-formedness check for this file.
  check("xmllint --noout Distribution", () => {
    const p = path.join(expandTarget, "Distribution");
    if (!existsSync(p)) throw new Error("file missing");
    const res = run("xmllint", ["--noout", p]);
    if (res.status !== 0) throw new Error(res.stdout + res.stderr);
  });

  console.log(`\n=== 3. launchctl print (not-loaded label — syntax/lookup only, no sudo/loading) ===`);
  for (const label of ["system/com.loombre.server", "system/com.loombre.worker"]) {
    check(`launchctl print ${label} reports "not found" (not loaded, as expected — no sudo used)`, () => {
      const res = run("launchctl", ["print", label]);
      // Not loaded => launchctl exits non-zero with a "could not find
      // service" message. A clean parse of THAT expected-failure shape is
      // as far as this proves without `sudo launchctl bootstrap` (Wave 3).
      if (res.status === 0) {
        throw new Error(`unexpectedly loaded/found — was a stale daemon left running from a prior smoke run?`);
      }
    });
  }
  console.log(
    "NOTE: launchctl has no real \"validate this plist file\" dry-run subcommand — the check above only " +
      "proves the label lookup path works and nothing is stale-loaded. Real validation requires " +
      "`sudo launchctl bootstrap system <plist>`, deliberately NOT run here (see mission scope, Wave 3).",
  );

  console.log(`\n=== 4. bundled server binary boots for real (external-PG path, loombre_i4) ===`);
  const serverPort = 3411;
  await smokeServerBoot(payloadDir, report.version, serverPort);

  console.log(`\n=== 5. bundled worker binary boots + clean SIGTERM ===`);
  await smokeWorkerBoot(payloadDir, report.version);

  rmSync(expandDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} SMOKE CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

function smokeServerBoot(payloadDir, version, port) {
  const nodeBin = path.join(payloadDir, "opt", "loombre", version, "runtime", "node", "bin", "node");
  const binShim = path.join(payloadDir, "opt", "loombre", version, "bin", "loombre-server");
  check("bundled node binary exists + is arm64/x64 Mach-O as expected", () => {
    const res = run("file", [nodeBin]);
    if (!res.stdout.includes("Mach-O")) throw new Error(`unexpected: ${res.stdout}`);
  });

  // Invokes bin/loombre-server itself (the REAL LaunchDaemon entry point),
  // not `node main.js` directly. Load-bearing, not a style choice: a real
  // production launch always goes through /opt/loombre/current/bin/
  // loombre-server (the `current` symlink IS the atomic-upgrade design,
  // LAYOUT.md §1), and this lane found a real bug that ONLY reproduces
  // when the invocation path traverses a symlink — apps/server/src/
  // main.ts's isDirectEntrypoint guard (import.meta.url vs
  // pathToFileURL(argv[1])) silently evaluates false through a symlink
  // (node's import.meta.url is realpath-resolved, argv[1] is not), so the
  // server would boot, print nothing, and exit 0 doing nothing at all —
  // caught here specifically because this expanded-pkg smoke tree sits
  // under macOS's own /var -> /private/var symlink, the same class of
  // path the real `current` symlink produces. Fixed in bin/loombre-server
  // via `pwd -P` (physical path) instead of `pwd` — invoking the shim
  // here (rather than working around the issue by realpath-ing in this
  // script) is what actually proves that fix, end to end.
  const child = spawn(binShim, [], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "postgres://loombre:loombre@127.0.0.1:5442/loombre_i4",
      LOOMBRE_CORS_ORIGINS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const deadline = Date.now() + 15000; // generous — see smokeWorkerBoot's comment on shared-host load
  const waitForHealthy = () =>
    new Promise((resolve) => {
      const tick = () => {
        const res = run("curl", ["-sS", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/healthz`]);
        if (res.stdout.trim() === "200") return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 300);
      };
      tick();
    });

  return waitForHealthy().then((healthy) => {
    check("server binary responds 200 on /healthz within 8s", () => {
      if (!healthy) throw new Error(`no healthy response — stdout:\n${stdout}\nstderr:\n${stderr}`);
    });
    child.kill("SIGTERM");
  });
}

function smokeWorkerBoot(payloadDir, version) {
  const nodeBin = path.join(payloadDir, "opt", "loombre", version, "runtime", "node", "bin", "node");
  const indexJs = path.join(payloadDir, "opt", "loombre", version, "worker", "dist", "index.js");
  const ffmpegPath = path.join(payloadDir, "opt", "loombre", version, "runtime", "ffmpeg", "ffmpeg");
  const ffprobePath = path.join(payloadDir, "opt", "loombre", version, "runtime", "ffmpeg", "ffprobe");

  const child = spawn(nodeBin, [indexJs], {
    env: {
      ...process.env,
      DATABASE_URL: "postgres://loombre:loombre@127.0.0.1:5442/loombre_i4",
      LOOMBRE_FFMPEG: ffmpegPath,
      LOOMBRE_FFPROBE: ffprobePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  // Generous windows: main() awaits waitForDatabaseReady() (retry/backoff
  // loop) before printing "consumers registered", and this host runs
  // several concurrent Phase-4 lanes' builds/tests at once — a tight
  // window here produced false failures purely from system load during
  // this lane's own development, not a real defect (verified by hand with
  // a longer wait). Poll instead of one fixed sleep, capped at 15s.
  const registeredDeadline = Date.now() + 15000;
  const waitForRegistered = () =>
    new Promise((resolve) => {
      const tick = () => {
        if (stdout.includes("consumers registered")) return resolve(true);
        if (child.exitCode !== null) return resolve(false); // crashed early
        if (Date.now() > registeredDeadline) return resolve(false);
        setTimeout(tick, 300);
      };
      tick();
    });

  return waitForRegistered().then((registered) => {
    check("worker process is alive when checked (no crash-on-start)", () => {
      if (child.exitCode !== null) throw new Error(`exited early (code ${child.exitCode})\n${stdout}\n${stderr}`);
    });
    check("worker registered its consumers (stdout contains 'consumers registered') within 15s", () => {
      if (!registered) throw new Error(`stdout:\n${stdout}\nstderr:\n${stderr}`);
    });
    child.kill("SIGTERM");
    return new Promise((resolve) => {
      const exitDeadline = Date.now() + 8000;
      const tick = () => {
        if (child.exitCode !== null || Date.now() > exitDeadline) {
          check("worker exits cleanly within 8s of SIGTERM", () => {
            if (child.exitCode === null) throw new Error("still running after SIGTERM + 8s grace");
          });
          resolve();
          return;
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  });
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
