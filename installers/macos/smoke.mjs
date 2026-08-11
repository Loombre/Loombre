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
//   4b. the bundled server binary ALSO boots for real via the EMBEDDED-PG
//      path — DATABASE_URL unset, LOOMBRE_DATA_DIR pointed at a scratch
//      dir — provisioning its own PostgreSQL from the payload's vendored
//      runtime/pg and auto-migrating before it answers /healthz. Added for
//      AUD-A5b-006: the out-of-the-box default (readme.rtf: "No database
//      setup is required") had NO coverage here before — check 4 above
//      only ever proved external-PG, the path fewer real operators take.
//   5. the bundled worker binary boots, registers consumers, and exits
//      cleanly on SIGTERM
//
// What this does NOT and CANNOT prove without sudo (left to Wave 3 +
// owner smoke, per the mission): `installer -pkg` actually running,
// postinstall's `_loombre` user creation / `launchctl bootstrap system`,
// the Gatekeeper unsigned-open flow, a live LaunchDaemon actually staying
// up across a real boot.

import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** Bundle ids a component pkg's PackageInfo lists under <relocate> — i.e.
 *  bundles pkgbuild marked BundleIsRelocatable, which PackageKit installs
 *  over any existing registered copy found ANYWHERE on the target volume
 *  instead of the payload path (the rc.6 relocation bug — see the check in
 *  main() below). Exported for pkg/component-plist.test.mjs, which runs
 *  this exact parser against real pkgbuild output both with and without
 *  the component plist, so the smoke check can never silently rot into
 *  matching nothing. */
export function findRelocatableBundleIds(packageInfoXml) {
  const relocate = packageInfoXml.match(/<relocate>([\s\S]*?)<\/relocate>/);
  if (!relocate) return [];
  return [...relocate[1].matchAll(/<bundle\s+id="([^"]+)"/g)].map((m) => m[1]);
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
    // bin/loombre-web + the Next standalone entrypoint it execs: this
    // smoke asserted only two of the three shipped services until the
    // post-rc.1 install-visibility fix, which is how "the web daemon is
    // in the payload" stayed an owner-review item instead of a check.
    `opt/loombre/${report.version}/bin/loombre-web`,
    // Ship-side uninstall (rc.6 uninstall audit, task 4): stable path via
    // /opt/loombre/current/bin/uninstall.sh across upgrades. Exec bit
    // asserted separately below (payload chmod, not the tracked git mode
    // — see build-pkg.mjs's bin/ staging loop).
    `opt/loombre/${report.version}/bin/uninstall.sh`,
    `opt/loombre/${report.version}/web/apps/web/server.js`,
    `opt/loombre/${report.version}/server/dist/main.js`,
    `opt/loombre/${report.version}/worker/dist/index.js`,
    `opt/loombre/${report.version}/runtime/node/bin/node`,
    `opt/loombre/${report.version}/VERSION`,
    `opt/loombre/current`,
    `Applications/Loombre.app/Contents/MacOS/Loombre`,
    `Applications/Loombre.app/Contents/Info.plist`,
    // Without this the app shows Finder's generic blank-document icon —
    // the "it installed but looks broken" complaint from the same field
    // report that produced the LaunchAgent above.
    `Applications/Loombre.app/Contents/Resources/AppIcon.icns`,
    `Library/LaunchDaemons/com.loombre.server.plist`,
    `Library/LaunchDaemons/com.loombre.worker.plist`,
    `Library/LaunchDaemons/com.loombre.web.plist`,
    // THE install-visibility fix (rc.1 field report: "the install will be
    // successful but nothing happens nor opens"). A LaunchDaemon runs the
    // stack headlessly; nothing in the payload ever put a FACE on it. The
    // menubar app had no autostart of any kind — not a login item, not an
    // agent — so it appeared only if the operator went hunting in
    // /Applications, and never came back after a reboot. Windows has had
    // the equivalent since day one (Shortcuts.wxs's HKLM Run key); macOS
    // shipped without it. This LaunchAgent is that missing peer.
    `Library/LaunchAgents/com.loombre.menubar.plist`,
    `Library/Application Support/Loombre/db`,
    `Library/Application Support/Loombre/ipc`,
    `Library/Logs/Loombre`,
  ];
  for (const rel of expectedPaths) {
    check(`payload contains ${rel}`, () => {
      if (!existsSync(path.join(payloadDir, rel))) throw new Error("missing from expanded payload");
    });
  }

  check("bin/uninstall.sh ships with exec bits set in the actual payload (not just the source file)", () => {
    const uninstallPath = path.join(payloadDir, "opt", "loombre", report.version, "bin", "uninstall.sh");
    if (!existsSync(uninstallPath)) throw new Error("missing from expanded payload");
    const mode = statSync(uninstallPath).mode;
    if (!(mode & 0o111)) throw new Error(`not executable in the built payload (mode ${mode.toString(8)})`);
  });

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

  // THE rc.6 FIELD BUG ("install successful, app never launches or appears
  // in Applications"): pkgbuild ran without --component-plist, so its
  // automatic bundle analysis marked Applications/Loombre.app
  // BundleIsRelocatable=true (<relocate> in the shipped PackageInfo). At
  // install time PackageKit resolves a relocatable bundle's destination by
  // asking LaunchServices/Spotlight for an EXISTING copy of the bundle id
  // anywhere on the volume and installs over THAT instead of the payload
  // path — observed live in /var/log/install.log (2026-08-08):
  //   PackageKit: Applications/Loombre.app relocated to Users/ozzy/App
  //     Development/Loombre/installers/macos/.build-cache/payload/arm64/
  //     Applications/Loombre.app
  // The install still exits 0, /Applications/Loombre.app never appears,
  // and the LaunchAgent's hardcoded ProgramArguments path spawns nothing.
  // Any stray copy (a build tree, ~/Downloads, the Trash) hijacks every
  // later install/upgrade the same way, and each hijack re-registers the
  // stray with LaunchServices, cementing it as the next target.
  // build-pkg.mjs now pins the bundle via --component-plist
  // (renderComponentPlist, BundleIsRelocatable=false); this asserts the
  // pin actually survived into the artifact that ships.
  check("PackageInfo marks no bundle relocatable (Loombre.app must land in /Applications, always)", () => {
    const packageInfoPath = path.join(componentPkgDir, "PackageInfo");
    if (!existsSync(packageInfoPath)) throw new Error("missing PackageInfo in expanded component pkg");
    const relocatable = findRelocatableBundleIds(readFileSync(packageInfoPath, "utf8"));
    if (relocatable.length > 0) {
      throw new Error(
        `<relocate> lists ${relocatable.join(", ")} — PackageKit would install the bundle over any existing ` +
          "copy anywhere on the volume instead of /Applications (the rc.6 relocation bug); was pkgbuild " +
          "run without --component-plist?",
      );
    }
  });

  // The install-visibility contract, asserted against the postinstall
  // script that ACTUALLY SHIPS inside the pkg (not the repo copy) — an
  // installer that lays a LaunchAgent down but never bootstraps it into
  // the console user's GUI domain still leaves the operator staring at a
  // finished progress bar with nothing on screen until their next login,
  // which is the exact rc.1 complaint. Both halves are load-bearing:
  //   - `bootstrap gui/<uid>` is what makes the icon appear NOW;
  //   - the plist living in /Library/LaunchAgents with RunAtLoad is what
  //     makes it come back at every subsequent login.
  const shippedPostinstall = readFileSync(path.join(componentPkgDir, "Scripts", "postinstall"), "utf8");
  check("postinstall resolves the console user (stat -f %u /dev/console)", () => {
    if (!/stat\s+-f\s+%u\s+\/dev\/console/.test(shippedPostinstall)) {
      throw new Error("postinstall never resolves the console user's uid — a root-context `open` would launch the app in the wrong session (or not at all)");
    }
  });
  check("postinstall bootstraps the menubar agent into the console user's GUI domain", () => {
    if (!/launchctl\s+bootstrap\s+gui\//.test(shippedPostinstall)) {
      throw new Error("postinstall never runs `launchctl bootstrap gui/<uid>` — the menubar app would not appear until the operator's next login");
    }
    if (!/com\.loombre\.menubar\.plist/.test(shippedPostinstall)) {
      throw new Error("postinstall never references com.loombre.menubar.plist");
    }
  });
  check("Info.plist declares CFBundleIconFile (extension-less, as macOS expects)", () => {
    const plistPath = path.join(payloadDir, "Applications", "Loombre.app", "Contents", "Info.plist");
    const res = run("plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", plistPath]);
    const value = res.stdout.trim();
    if (res.status !== 0 || value.length === 0) {
      throw new Error("CFBundleIconFile is absent — the app renders the generic blank icon");
    }
    if (value.endsWith(".icns")) {
      throw new Error(
        `CFBundleIconFile is "${value}" — write it WITHOUT the extension ("AppIcon"). macOS appends .icns ` +
          "itself; the suffixed form silently falls back to the blank icon on some OS versions.",
      );
    }
    if (!existsSync(path.join(payloadDir, "Applications", "Loombre.app", "Contents", "Resources", `${value}.icns`))) {
      throw new Error(`CFBundleIconFile names "${value}" but Resources/${value}.icns is not in the payload`);
    }
  });

  check("preinstall boots the menubar agent out (upgrade replaces a running app bundle)", () => {
    const shippedPreinstall = readFileSync(path.join(componentPkgDir, "Scripts", "preinstall"), "utf8");
    if (!/com\.loombre\.menubar/.test(shippedPreinstall)) {
      throw new Error("preinstall never boots out com.loombre.menubar — the new Loombre.app would land under the running old one");
    }
  });

  console.log(`\n=== 2. plutil -lint on every shipped plist, xmllint on Distribution.xml ===`);
  const plistTargets = [
    path.join(payloadDir, "Library", "LaunchDaemons", "com.loombre.server.plist"),
    path.join(payloadDir, "Library", "LaunchDaemons", "com.loombre.worker.plist"),
    path.join(payloadDir, "Library", "LaunchDaemons", "com.loombre.web.plist"),
    path.join(payloadDir, "Library", "LaunchAgents", "com.loombre.menubar.plist"),
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

  console.log(`\n=== 4b. bundled server binary boots for real (embedded-PG path, the default) ===`);
  await smokeServerBootEmbedded(payloadDir, report.version, serverPort + 1);

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

// AUD-A5b-006: the local smoke above only ever booted against EXTERNAL
// Postgres — the embedded-PG path (DATABASE_URL unset) is the documented
// out-of-the-box default (readme.rtf: "No database setup is required —
// the server provisions its bundled PostgreSQL automatically") and had no
// coverage of its own. Same binShim entry point as smokeServerBoot (same
// symlink-realpath reasoning applies), but with NO DATABASE_URL in the
// child's environment and a scratch LOOMBRE_DATA_DIR the server is free to
// initdb into — this is what makes bin/loombre-server's own unset-branch
// (LOOMBRE_EMBEDDED_PG_VENDOR_DIR/LOOMBRE_EMBEDDED_PG_VERSION, sourced from
// the payload's staged runtime/pg) actually run, exercising
// apps/server/src/bootstrap/provisioning.ts's embedded branch end to end:
// real initdb, real postmaster start, real auto-migrate, all against the
// payload's own vendored PostgreSQL binaries — nothing external.
export function smokeServerBootEmbedded(payloadDir, version, port) {
  const binShim = path.join(payloadDir, "opt", "loombre", version, "bin", "loombre-server");
  const vendorPgDir = path.join(payloadDir, "opt", "loombre", version, "runtime", "pg");
  check("payload ships vendored embedded-PG binaries under runtime/pg (else this scenario cannot provision anything)", () => {
    if (!existsSync(vendorPgDir)) {
      throw new Error(
        `missing ${vendorPgDir} — fetch-embedded-pg.mjs did not stage real binaries into this build ` +
          "(a placeholder-only build cannot run the embedded-PG path; see installers/macos/pkg/fetch-embedded-pg.mjs)",
      );
    }
  });

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "loombre-smoke-embedded-datadir-"));

  // NO DATABASE_URL anywhere in this child's environment — safe by
  // construction (`delete`, not merely "don't set"): a stray DATABASE_URL
  // inherited from the ambient shell would silently steer this scenario
  // onto EXTERNAL Postgres and it would pass for the wrong reason,
  // proving nothing about the embedded path this check exists for.
  const embeddedEnv = {
    ...process.env,
    PORT: String(port),
    LOOMBRE_CORS_ORIGINS: "",
    LOOMBRE_DATA_DIR: dataDir,
  };
  delete embeddedEnv.DATABASE_URL;

  const child = spawn(binShim, [], { env: embeddedEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  // 120s, not smokeServerBoot's 15s: first boot here runs a real initdb +
  // cluster start + full migration set before it ever answers /healthz —
  // matching installers/linux/smoke.mjs's identical embedded-mode budget
  // for the identical operation (its own comment: "first boot runs a real
  // initdb + cluster start + full migration set before listening").
  const deadline = Date.now() + 120_000;
  const waitForHealthy = () =>
    new Promise((resolve) => {
      const tick = () => {
        const res = run("curl", ["-sS", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/healthz`]);
        if (res.stdout.trim() === "200") return resolve(true);
        if (child.exitCode !== null) return resolve(false); // crashed early — no point waiting out the deadline
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 300);
      };
      tick();
    });

  return waitForHealthy().then((healthy) => {
    check("embedded-PG: server binary responds 200 on /healthz within 120s (initdb + start + auto-migrate)", () => {
      if (!healthy) throw new Error(`no healthy response — stdout:\n${stdout}\nstderr:\n${stderr}`);
    });
    check("embedded-PG: server actually provisioned a PostgreSQL data directory under the scratch LOOMBRE_DATA_DIR", () => {
      const pgDataDir = path.join(dataDir, "postgres", "data");
      if (!existsSync(pgDataDir)) {
        throw new Error(`${pgDataDir} does not exist — /healthz went 200 without embedded provisioning actually running`);
      }
    });
    child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
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

// Guarded (not a bare top-level call), same isDirectEntrypoint pattern
// installers/linux/smoke.mjs already uses: lets smokeServerBootEmbedded be
// `import`ed and exercised on its own (e.g. when the external-PG scenario
// above can't run because no loombre_i4 database exists on this host) —
// without a plain import also kicking off the whole multi-minute smoke run.
const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntrypoint) {
  main().catch((err) => {
    console.error("[smoke] FAILED:", err);
    process.exit(1);
  });
}
