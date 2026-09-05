// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/release-workflow-linux.test.mjs
//
// Shape guard for .github/workflows/release.yml's build-linux job — the
// .rpm/.deb sibling of release-workflow-macos.test.mjs's coverage of
// build-macos (same jobBlock helper, same text-level-assertion posture:
// node-builtins-only, no YAML parser dependency, matching every other
// script under scripts/release/).
//
// What actually breaks if these steps regress, and what each assertion
// below guards:
//   - build-rpm.mjs / build-deb.mjs must each be called with the tarball
//     build-tarball.mjs (lane I1) just staged into dist/release, and must
//     write back into that same directory — a hard-coded installers/linux/
//     dist path here would build a package the Upload artifact step (which
//     globs dist/release/**) never picks up.
//   - `rpm` (rpmbuild) is not preinstalled on ubuntu-latest; the tooling
//     step must run BEFORE build-rpm.mjs or the native packer resolution
//     (installers/linux/lib/native-package.mjs's resolvePacker) falls back
//     to the slower docker path instead of failing loudly.
//   - the deb install smoke boots a REAL systemd unit (first boot runs
//     initdb + migrations, see build-macos's own "Install smoke" step for
//     the same real-boot bar) — a systemctl is-active check that races
//     ahead of the healthz poll would flake on a slow first boot instead
//     of giving it the full 150s.
//   - `apt-get purge -y loombre` must run so the guard scenarios
//     smoke-packages.mjs exercises next start from a truly clean host.
//   - smoke-packages.mjs is the REAL per-distro check (fedora/rocky/debian
//     containers, each installing with its own package manager) — the
//     macOS lane's equivalent regression (a real Mac failing a PERFECTLY
//     GREEN build) is exactly the class of bug this step exists to catch
//     on Linux; it must actually run with both artifacts wired in.
//
// Run via `pnpm scripts:test` or `node --test scripts/release/test/`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/release.yml"),
  "utf8",
);

/** Text of one top-level job (2-space indent under `jobs:`), up to the next job key. */
function jobBlock(jobId) {
  // Terminates at the next 2-space job key OR end of file (`release` is last).
  const re = new RegExp(
    `^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:[ \\t]*$|$(?![\\s\\S]))`,
    "m",
  );
  const match = re.exec(WORKFLOW);
  assert.ok(match, `release.yml has no top-level job "${jobId}"`);
  return match[1];
}

const buildLinux = jobBlock("build-linux");
const release = jobBlock("release");

test("build-rpm.mjs is called with the just-built tarball and writes back into dist/release", () => {
  assert.match(
    buildLinux,
    /node installers\/linux\/build-rpm\.mjs\b/,
    "build-rpm.mjs must be invoked",
  );
  assert.match(
    buildLinux,
    /build-rpm\.mjs[^\n]*--tarball "dist\/release\//,
    "build-rpm.mjs must take its --tarball from dist/release (the same directory build-tarball.mjs just staged into)",
  );
  assert.match(
    buildLinux,
    /build-rpm\.mjs[^\n]*--out-dir dist\/release/,
    "build-rpm.mjs must write its --out-dir back into dist/release, not installers/linux/dist, or Upload artifact's glob will miss it",
  );
});

test("build-deb.mjs is called with the just-built tarball and writes back into dist/release", () => {
  assert.match(
    buildLinux,
    /node installers\/linux\/build-deb\.mjs\b/,
    "build-deb.mjs must be invoked",
  );
  assert.match(
    buildLinux,
    /build-deb\.mjs[^\n]*--tarball "dist\/release\//,
    "build-deb.mjs must take its --tarball from dist/release",
  );
  assert.match(
    buildLinux,
    /build-deb\.mjs[^\n]*--out-dir dist\/release/,
    "build-deb.mjs must write its --out-dir back into dist/release",
  );
});

test("rpm build tooling is installed before build-rpm.mjs runs", () => {
  const toolingIdx = buildLinux.indexOf("apt-get install -y rpm");
  const buildRpmIdx = buildLinux.indexOf("node installers/linux/build-rpm.mjs");
  assert.ok(toolingIdx !== -1, "must install rpm build tooling (rpmbuild) somewhere in build-linux");
  assert.ok(buildRpmIdx !== -1, "build-rpm.mjs must be invoked somewhere in build-linux");
  assert.ok(
    toolingIdx < buildRpmIdx,
    "`apt-get install -y rpm` must run BEFORE build-rpm.mjs, or native packer resolution has nothing to find on PATH",
  );
});

test("the deb install smoke polls healthz before checking systemctl is-active, then purges", () => {
  const healthzIdx = buildLinux.indexOf("127.0.0.1:3001/healthz");
  const isActiveIdx = buildLinux.indexOf("systemctl is-active");
  const purgeIdx = buildLinux.indexOf("apt-get purge -y loombre");
  assert.ok(healthzIdx !== -1, "the install smoke must poll /healthz");
  assert.ok(isActiveIdx !== -1, "the install smoke must check systemctl is-active for the units");
  assert.ok(purgeIdx !== -1, "the install smoke must purge the package");
  assert.ok(
    healthzIdx < isActiveIdx,
    "the healthz poll must precede the systemctl is-active check — first boot (initdb + migrations) can take a while, and is-active alone does not prove the server actually came up",
  );
  assert.ok(
    isActiveIdx < purgeIdx,
    "apt-get purge -y loombre must be asserted AFTER the boot checks, not run speculatively before them",
  );
});

test("the deb install smoke dumps journalctl on a healthz timeout", () => {
  assert.match(
    buildLinux,
    /journalctl -u loombre-server\b/,
    "a healthz timeout must print journalctl for loombre-server (units log to the journal, not a file — see build-tarball.mjs's StandardOutput=journal note)",
  );
});

test("the deb install smoke asserts /setup/state reports needsSetup:true and the CLI symlink prints the version", () => {
  assert.match(
    buildLinux,
    /setup\/state/,
    "must check /setup/state",
  );
  assert.match(
    buildLinux,
    /needsSetup/,
    "must assert needsSetup is reported",
  );
  assert.match(
    buildLinux,
    /\/usr\/bin\/loombre --version/,
    "must assert the installed CLI symlink prints the version",
  );
});

test("the deb install smoke asserts purge removes /opt/loombre, /var/lib/loombre, /etc/loombre and the loombre user", () => {
  for (const p of ["/opt/loombre", "/var/lib/loombre", "/etc/loombre"]) {
    assert.ok(
      buildLinux.includes(p),
      `install smoke must reference ${p} (asserted gone after purge)`,
    );
  }
  assert.match(
    buildLinux,
    /getent passwd loombre/,
    "must check the loombre system user is gone after purge",
  );
});

test("smoke-packages.mjs runs against the built .rpm AND .deb", () => {
  assert.match(
    buildLinux,
    /node installers\/linux\/smoke-packages\.mjs\b/,
    "smoke-packages.mjs must be invoked",
  );
  assert.match(
    buildLinux,
    /smoke-packages\.mjs[\s\S]*?--rpm "dist\/release\//,
    "smoke-packages.mjs must be given --rpm",
  );
  assert.match(
    buildLinux,
    /smoke-packages\.mjs[\s\S]*?--deb "dist\/release\//,
    "smoke-packages.mjs must be given --deb",
  );
  // ubuntu:26.04 ships no libxml2.so.2 package; installers/libxml2-manifest.json
  // vendors one beside the embedded PostgreSQL precisely so the .deb installs
  // there — the matrix must keep proving it on every tagged build.
  assert.match(
    buildLinux,
    /smoke-packages\.mjs[\s\S]*?--distros [^\n]*\bubuntu:26\.04\b/,
    "smoke-packages.mjs's --distros must include ubuntu:26.04 (the vendored-libxml2 proof case)",
  );
});

test("the release job still needs build-linux", () => {
  assert.match(
    release,
    /needs:\s*\[[^\]]*\bbuild-linux\b[^\]]*\]/,
    "release must depend on build-linux",
  );
});
