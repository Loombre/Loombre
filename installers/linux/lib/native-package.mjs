// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/lib/native-package.mjs
//
// The shared layer behind installers/linux/build-rpm.mjs and build-deb.mjs:
// package identity, semver -> package-version mapping, template rendering,
// the FHS staging tree, the rpm spec, the deb control file + maintainer
// scripts, the bundled-license inventory, and the packer-tool resolution
// (native binary, or the pinned ubuntu:24.04 image — the same rpm 4.18 /
// dpkg-deb release.yml's ubuntu-latest build host uses — when the tool is
// absent locally).
//
// ONE PAYLOAD, THREE CONTAINERS. Both package builders take the already
// built tarball (installers/linux/build-tarball.mjs's output) as their only
// input: they extract it, stage its payload entries under /opt/loombre, and
// wrap them in package metadata. Nothing here re-runs pnpm, deploys, or
// fetches — the tarball is the single payload source of truth, so the three
// Linux channels can never ship different bytes for the same version.
//
// SAME SHAPE AS THE TARBALL'S DEFAULT INSTALL, ON PURPOSE. /opt/loombre,
// /var/lib/loombre, /etc/loombre/loombre.env, the `loombre` system user, and
// the three unit names are exactly what install.sh produces with default
// flags, so every doc, troubleshooting recipe, wrapper script, and the
// `loombre` CLI behave identically. The env file and the units are rendered
// from the SAME templates install.sh renders (installers/linux/
// loombre.env.template, systemd/*.service.template) with the same
// placeholder idiom — native-package.test.mjs proves byte-identity against
// install.sh's own sed expressions.
//
// DELIBERATE DIFFERENCES from the tarball channel (documented for operators
// in docs/install/linux.md):
//   1. units live in /usr/lib/systemd/system (package-owned), not
//      /etc/systemd/system (admin-owned) — `systemctl edit` drop-ins still
//      work and survive upgrades; a `systemctl edit --full` copy in /etc
//      shadows the packaged unit (the scriptlets warn about one);
//   2. the CLI symlink is /usr/bin/loombre — FHS / Debian Policy 9.1.2 /
//      Fedora's guidelines all forbid packages touching /usr/local;
//   3. the system user is never removed by `rpm -e` (Fedora guideline: uids
//      may still own files) and only by `apt purge` on Debian;
//   4. no --prefix/--data-dir/--user relocation — a package has fixed paths;
//      operators who need relocation use the tarball;
//   5. `--no-start` becomes a flag file: an operator who wants to edit the
//      env file before anything binds a port creates /etc/loombre/no-autostart
//      before installing; the install scriptlet honours and consumes it.
//
// THE ENV FILE IS MAINTAINER-SCRIPT MANAGED on both formats (Debian Policy
// 10.7.3; the rpm equivalent of a %ghost'd config): the rendered default
// ships at /usr/share/loombre/loombre.env, and the install scriptlet copies
// it to /etc/loombre/loombre.env only if that file is absent. Upgrades never
// touch it (no dpkg conffile prompt, no .rpmnew), a file restored BEFORE
// installing is honoured (the tarball -> package migration path), and only
// `apt purge` deletes it. Operators diff theirs against the shipped default
// after an upgrade to pick up new knobs.
//
// UPGRADES STOP BEFORE UNPACK AND START AFTER (dh's --no-restart-after-
// upgrade posture, not restart-after): the pre-upgrade scriptlet records
// which units are active in a /run marker and stops them; the last
// scriptlet of the NEW package starts exactly those. Restarting after
// unpack would leave a running postmaster and node pointed at files the
// unpack deleted (a PostgreSQL minor bump removes pg/<old version>/ — new
// backends could not load plpgsql; pnpm's hash-suffixed node_modules
// directories change between releases — lazy requires would fail) for the
// whole unpack window. A few seconds of downtime is the honest trade.
//
// The writable Next runtime-cache directory under the payload
// (/opt/loombre/web/apps/web/.next/cache — the ONE spot the hardened
// loombre-web unit may write to, see the unit template) is NOT shipped: the
// install scriptlets create it owned by the service user, exactly as
// install.sh does, and the erase/remove scriptlets delete it (package
// managers never remove directories holding files they did not ship).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────

export const PACKAGE_META = Object.freeze({
  name: "loombre",
  summary: "Self-hosted media streaming platform (server, worker, web UI)",
  // Wrapped by the renderers; keep each sentence self-contained.
  description: [
    "Loombre is a self-hosted media streaming platform: an API server (port 3001),",
    "a background worker (library scans, probing, transcoding, metadata), and a",
    "browser UI (port 3000). The package bundles its own Node.js runtime,",
    "ffmpeg/ffprobe, and an embedded PostgreSQL, so nothing else needs installing:",
    "the first start provisions and migrates the database under /var/lib/loombre,",
    "then the web UI walks you through creating the admin account and adding",
    "libraries. Configuration lives in /etc/loombre/loombre.env.",
    "",
    "Documentation: https://github.com/Loombre/Loombre (docs/install/linux.md).",
  ],
  homepage: "https://github.com/Loombre/Loombre",
  vendor: "Loombre Project",
  // No public project mailbox exists yet (owner decision pending — recorded
  // in the PKG run's OPEN items). dpkg requires an RFC-822 Maintainer, and a
  // contributor's personal address must not be baked into release artifacts.
  maintainer: "Loombre Project <noreply@loombre.com>",
  // The fixed head of the SPDX expression for the AGGREGATE this package
  // ships: Loombre itself (AGPL-3.0-only), the bundled ffmpeg/ffprobe
  // (GPL-3.0-or-later — BtbN "-gpl" builds, see installers/ffmpeg-manifest.json's
  // provenance block for the mere-aggregation argument), the bundled
  // PostgreSQL (PostgreSQL License), and the bundled Node.js runtime (MIT).
  // rpmLicenseExpression() appends every other identifier the payload's
  // npm dependency inventory declares.
  licenseHead: ["AGPL-3.0-only", "GPL-3.0-or-later", "PostgreSQL", "MIT"],
  debSection: "video",
  rpmGroup: "Applications/Multimedia",
});

export const DEFAULT_PATHS = Object.freeze({
  prefix: "/opt/loombre",
  dataDir: "/var/lib/loombre",
  configDir: "/etc/loombre",
  envFile: "/etc/loombre/loombre.env",
  noAutostartFlag: "/etc/loombre/no-autostart",
  shareDir: "/usr/share/loombre",
  envDefault: "/usr/share/loombre/loombre.env",
  user: "loombre",
  group: "loombre",
  unitDir: "/usr/lib/systemd/system",
  sysusersFile: "/usr/lib/sysusers.d/loombre.conf",
  binLink: "/usr/bin/loombre",
  docDir: "/usr/share/doc/loombre",
  licenseDir: "/usr/share/licenses/loombre",
  webCacheDir: "/opt/loombre/web/apps/web/.next/cache",
});

export const SERVICES = Object.freeze(["loombre-server", "loombre-worker", "loombre-web"]);
/** Stop order: dependants first, the PostgreSQL-hosting server last. */
export const STOP_ORDER = Object.freeze(["loombre-worker", "loombre-web", "loombre-server"]);

/** The tarball entries a package ships under /opt/loombre — install.sh's
 *  `for entry in ...` payload copy list, verbatim (native-package.test.mjs
 *  pins the two against each other). */
export const PAYLOAD_ENTRIES = Object.freeze(["bin", "lib", "runtime", "ffmpeg", "web", "pg", "packages", "VERSION"]);

/** Tarball-channel files that must NEVER land inside a package (the package
 *  IS the installer; the templates are rendered at package-build time). */
export const TARBALL_ONLY_ENTRIES = Object.freeze(["install.sh", "uninstall.sh", "systemd", "loombre.env.template"]);

export const ARCHES = Object.freeze({
  x64: Object.freeze({ rpm: "x86_64", deb: "amd64", elf: "x86_64", platform: "linux-x64" }),
  arm64: Object.freeze({ rpm: "aarch64", deb: "arm64", elf: "aarch64", platform: "linux-arm64" }),
});

/** The pinned packer image for hosts without rpmbuild / dpkg-deb (a macOS
 *  dev machine). ubuntu:24.04 on purpose — it carries the SAME rpm 4.18 and
 *  dpkg-deb 1.22 release.yml's ubuntu-latest build host uses, so a locally
 *  built package is produced by the exact toolchain CI runs, not a Fedora
 *  or Debian one (and rpm 4.18 writes the v4 package format every rpm from
 *  4.14 through 6.x reads). Digest-pinned (repo convention: actions by SHA,
 *  images by digest); bump deliberately. */
export const PACKER_IMAGE = "ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90";

// ─────────────────────────────────────────────────────────────────────────
// Versions and names
// ─────────────────────────────────────────────────────────────────────────

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(version) {
  const m = typeof version === "string" ? SEMVER_PATTERN.exec(version) : null;
  if (!m) throw new Error(`native-package: ${JSON.stringify(version)} is not a valid semver version`);
  return { core: `${m[1]}.${m[2]}.${m[3]}`, prerelease: m[4] ?? null, build: m[5] ?? null };
}

function packageVersionFor(version, format) {
  const { core, prerelease } = parseSemver(version);
  if (prerelease === null) return core;
  // Neither rpm nor dpkg allows '-' inside a version; our releases use dotted
  // identifiers (beta.1, rc.1). Refuse rather than guess a rewrite.
  if (prerelease.includes("-")) {
    throw new Error(
      `native-package: semver pre-release ${JSON.stringify(prerelease)} contains '-', which a ${format} version cannot carry — use dotted identifiers (beta.1, rc.1)`,
    );
  }
  // '~' sorts BEFORE the empty string in both rpm (>= 4.10) and dpkg, so
  // 1.0.0~beta.1 < 1.0.0~rc.1 < 1.0.0 — the semver precedence, preserved.
  // Build metadata (+…) is dropped: semver ignores it for precedence and
  // neither format has a slot for it. (Consequence, documented in
  // linux.md: a same-version re-cut needs `dnf reinstall` / `apt reinstall`.)
  return `${core}~${prerelease}`;
}

/** semver -> rpm { Version, Release }. Release is always 1 and never carries
 *  %{?dist}: one package installs on every rpm-based distro. */
export function semverToRpm(version) {
  return { version: packageVersionFor(version, "rpm"), release: "1" };
}

/** semver -> Debian version (no epoch, no Debian revision — a "native"
 *  version in dpkg's terms, hence changelog.gz rather than
 *  changelog.Debian.gz). */
export function semverToDeb(version) {
  return packageVersionFor(version, "deb");
}

const TARBALL_NAME_PATTERN = /^(loombre-(.+)-linux-(x64|arm64))\.tar\.gz$/;

/** `loombre-<semver>-linux-<x64|arm64>.tar.gz` (the release convention every
 *  build-* job's artifact follows — scripts/release/lib/build-manifest-lib.mjs)
 *  -> { name, version, arch }. Anything else throws, naming the input. */
export function parseTarballName(tarballPath) {
  const base = path.basename(tarballPath);
  const m = TARBALL_NAME_PATTERN.exec(base);
  if (!m || !SEMVER_PATTERN.test(m[2])) {
    throw new Error(`native-package: ${base} does not follow loombre-<semver>-linux-<x64|arm64>.tar.gz`);
  }
  return { name: m[1], version: m[2], arch: m[3] };
}

// ─────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /__[A-Z][A-Z0-9_]*__/g;

/** `__KEY__` substitution — the systemd/env templates' own idiom, mirrored
 *  from install.sh's sed expressions. Literal replacement (a path containing
 *  `$&` must not be interpreted), and a leftover placeholder is an error. */
export function renderTemplate(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`__${key}__`).join(String(value));
  }
  const leftover = out.match(PLACEHOLDER_PATTERN);
  if (leftover) throw new Error(`native-package: template still contains ${[...new Set(leftover)].join(", ")} after rendering`);
  return out;
}

function unitVars(paths) {
  return { PREFIX: paths.prefix, DATA_DIR: paths.dataDir, CONFIG_DIR: paths.configDir, LOOMBRE_USER: paths.user };
}

export function renderUnit(templateText, paths) {
  return renderTemplate(templateText, unitVars(paths));
}

export function renderEnvFile(templateText, paths) {
  return renderTemplate(templateText, { DATA_DIR: paths.dataDir, PREFIX: paths.prefix });
}

/** systemd-sysusers declaration: on distros whose systemd re-creates
 *  declared users at boot this restores the account if an operator deleted
 *  it; the scriptlets still create it themselves (getent-guarded, adopting
 *  an orphaned data-dir uid) so the package installs on hosts without
 *  sysusers support too. */
export function sysusersConf(paths) {
  return [
    "# Loombre :: /usr/lib/sysusers.d/loombre.conf — the service account the",
    "# loombre-server/worker/web units run as (systemd-sysusers(8) format).",
    `g ${paths.group} -`,
    `u ${paths.user} - "Loombre media server" ${paths.dataDir} /usr/sbin/nologin`,
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Licenses — an inventory of what the payload actually declares
// ─────────────────────────────────────────────────────────────────────────

function declaredLicense(pkg) {
  let l = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses[0] : undefined);
  if (l && typeof l === "object") l = l.type;
  return typeof l === "string" && l.trim() ? l.trim() : null;
}

/**
 * Every `license` field declared by a package.json under a node_modules
 * directory in the payload, with a package count per identifier. The
 * source tree's license-check gate (LICENSE-INTENT.md) already proves each
 * of these is on the allow-list; this inventory is how the package's
 * License tag and copyright file stay truthful without a hand-typed list.
 *
 * @param {string} prefixDir the staged /opt/loombre
 * @returns {Map<string, number>} identifier -> package count, sorted by count desc then name
 */
export function licenseInventory(prefixDir) {
  const counts = new Map();
  const stack = [prefixDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name !== "package.json" || !full.split(path.sep).includes("node_modules")) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      const id = declaredLicense(pkg);
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

/** SPDX AND-expression for the rpm License tag: the fixed head (Loombre,
 *  ffmpeg, PostgreSQL, Node) followed by every inventory identifier not
 *  already named; compound identifiers ("MIT OR CC0-1.0") are parenthesised. */
export function rpmLicenseExpression(inventory, head = PACKAGE_META.licenseHead) {
  const parts = [...head];
  const seen = new Set(head);
  for (const id of [...inventory.keys()].sort()) {
    const clean = id.replace(/^\(|\)$/g, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    parts.push(/\s/.test(clean) ? `(${clean})` : clean);
  }
  return parts.join(" AND ");
}

function dep5Text(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "" ? " ." : ` ${line}`))
    .join("\n");
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * /usr/share/doc/loombre/copyright — machine-readable (DEP-5) aggregation
 * notice: every bundled component with its version and license, the AGPL
 * and PostgreSQL texts verbatim (neither is in Debian's common-licenses),
 * and the npm dependency inventory.
 *
 * @param {{ version: string, bundled: Record<string, string>, inventory?: Map<string, number>, agplText: string, postgresqlText?: string }} opts
 */
export function copyrightText({ version, bundled, inventory = new Map(), agplText, postgresqlText = "" }) {
  const lines = [
    "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/",
    "Upstream-Name: Loombre",
    `Upstream-Contact: ${PACKAGE_META.maintainer}`,
    `Source: ${PACKAGE_META.homepage}`,
    `Comment: Loombre ${version}. This package aggregates independently licensed`,
    " components, each shipped as separate executables under /opt/loombre and",
    " invoked as child processes (never linked into Loombre's own code).",
    "",
    "Files: *",
    "Copyright: Loombre contributors",
    "License: AGPL-3.0-only",
    "",
    "Files: opt/loombre/runtime/node/*",
    `Copyright: Node.js contributors (Node.js ${bundled.node ?? "unknown"})`,
    "License: MIT",
    " The official nodejs.org build. Node.js's own LICENSE file (MIT plus the",
    " licenses of its bundled V8, OpenSSL, ICU, zlib and libuv) ships as",
    " /opt/loombre/runtime/node/LICENSE.",
    "",
    "Files: opt/loombre/ffmpeg/*",
    `Copyright: FFmpeg developers (ffmpeg/ffprobe ${bundled.ffmpeg ?? "unknown"})`,
    "License: GPL-3.0-or-later",
    " The build's own license text ships as /opt/loombre/ffmpeg/LICENSE.txt",
    " (on Debian-family systems see also /usr/share/common-licenses/GPL-3).",
    " ffmpeg/ffprobe run as separate child processes — mere aggregation, see",
    " installers/ffmpeg-manifest.json's provenance block in the source tree.",
    "",
    "Files: opt/loombre/pg/*",
    `Copyright: PostgreSQL Global Development Group (PostgreSQL ${bundled.postgresql ?? "unknown"})`,
    "License: PostgreSQL",
    "",
    "Files: opt/loombre/lib/*/node_modules/* opt/loombre/web/node_modules/*",
    "Copyright: the respective npm package authors",
    "License: various-permissive",
    " Every runtime dependency's license is on the allow-list enforced by",
    " the source tree's license-check gate (LICENSE-INTENT.md); each package",
    " ships its own LICENSE file inside its directory. Declared identifiers",
    " in this build (package count):",
    ...[...inventory.entries()].map(([id, n]) => `  ${id}: ${n}`),
    "",
    "License: AGPL-3.0-only",
    dep5Text(agplText),
    "",
    "License: MIT",
    dep5Text(MIT_TEXT),
    "",
    "License: PostgreSQL",
    dep5Text(postgresqlText || "The PostgreSQL License (see /opt/loombre/pg/*/*/LICENSE)."),
    "",
  ];
  return lines.join("\n");
}

/** One-entry changelog (lintian hygiene — not the project changelog, which
 *  is CHANGELOG.md in the repository). Installed as changelog.gz: a version
 *  without a Debian revision is "native" in dpkg's terms. */
export function debChangelogText({ debVersion, date }) {
  return [
    `loombre (${debVersion}) unstable; urgency=medium`,
    "",
    "  * Packaged from the release tarball by installers/linux/build-deb.mjs.",
    "    See https://github.com/Loombre/Loombre/blob/main/CHANGELOG.md for the",
    "    release history.",
    "",
    ` -- ${PACKAGE_META.maintainer}  ${date}`,
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Payload inspection
// ─────────────────────────────────────────────────────────────────────────

function singleSubdir(dir, what) {
  if (!existsSync(dir)) throw new Error(`native-package: ${what}: ${dir} does not exist`);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  if (entries.length !== 1) {
    throw new Error(`native-package: ${what}: expected exactly one directory under ${dir}, found ${entries.length} (${entries.join(", ") || "none"})`);
  }
  return entries[0];
}

/** `pg/<platform>/<version>`, payload-relative POSIX. Exactly one
 *  platform+version pair is staged by build-tarball.mjs's assemblePg;
 *  anything else is a broken payload. */
export function payloadPgRelative(payloadDir) {
  const platform = singleSubdir(path.join(payloadDir, "pg"), "embedded PostgreSQL platform");
  const version = singleSubdir(path.join(payloadDir, "pg", platform), "embedded PostgreSQL version");
  return `pg/${platform}/${version}`;
}

/** `pg/<platform>/<version>/lib` — the directory the ELF dependency scan
 *  must EXCLUDE (optional extension modules; see lib/elf-deps.mjs's header). */
export function payloadPgLibRelative(payloadDir) {
  return `${payloadPgRelative(payloadDir)}/lib`;
}

/** Versions of the bundled components, for Provides: bundled(...) and the
 *  copyright file. PostgreSQL comes from the payload itself (the staged
 *  version directory); Node and ffmpeg from the pinned manifests the
 *  tarball was built from (their binaries cannot be executed on a foreign
 *  build host to ask). */
export function bundledVersionsFromPayload(payloadDir, repoRoot) {
  const platform = singleSubdir(path.join(payloadDir, "pg"), "embedded PostgreSQL platform");
  const postgresql = singleSubdir(path.join(payloadDir, "pg", platform), "embedded PostgreSQL version");
  const nodeManifest = JSON.parse(readFileSync(path.join(repoRoot, "installers", "node-manifest.json"), "utf8"));
  const ffmpegManifest = JSON.parse(readFileSync(path.join(repoRoot, "installers", "ffmpeg-manifest.json"), "utf8"));
  const ffmpegEntry = ffmpegManifest.platforms?.[platform] ?? ffmpegManifest.platforms?.["linux-x64"];
  return {
    node: String(nodeManifest.nodeVersion),
    ffmpeg: String(ffmpegEntry?.ffmpegVersion ?? "unknown"),
    postgresql,
  };
}

const TEMPLATE_FILES = Object.freeze([
  ...SERVICES.map((svc) => `systemd/${svc}.service.template`),
  "loombre.env.template",
  "install.sh",
  "uninstall.sh",
]);

/** The tarball bundles its own copies of the templates and installer
 *  scripts; the package builders render from the CHECKOUT's templates. If
 *  any of them disagree the tarball is stale relative to the checkout (or
 *  vice versa) and a package would ship units or an env file that differ
 *  from that tarball's own install.sh output — build-rpm/build-deb refuse
 *  unless told otherwise. install.sh/uninstall.sh are compared too: they
 *  never ship in a package, but a mismatch identifies a stale payload. */
export function templateDrift(payloadDir, checkoutLinuxDir) {
  const drift = [];
  for (const rel of TEMPLATE_FILES) {
    const inTarball = path.join(payloadDir, ...rel.split("/"));
    const inCheckout = path.join(checkoutLinuxDir, ...rel.split("/"));
    if (!existsSync(inTarball)) {
      drift.push({ file: rel, reason: "missing in the tarball" });
      continue;
    }
    if (!existsSync(inCheckout)) {
      drift.push({ file: rel, reason: "missing in the checkout" });
      continue;
    }
    if (!readFileSync(inTarball).equals(readFileSync(inCheckout))) drift.push({ file: rel, reason: "differs from the checkout" });
  }
  return drift;
}

// ─────────────────────────────────────────────────────────────────────────
// Staging
// ─────────────────────────────────────────────────────────────────────────

function chmodTreeGoMinusW(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      const mode = st.mode & 0o7777;
      if (mode & 0o022) chmodSync(full, mode & ~0o022);
      if (st.isDirectory()) stack.push(full);
    }
  }
}

function writeFile(full, content, mode) {
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  chmodSync(full, mode);
}

/**
 * Build the FHS tree both package formats wrap. `rootDir` is emptied first.
 *
 * @param {{
 *   payloadDir: string,       // the extracted tarball directory (loombre-<v>-linux-<arch>/)
 *   rootDir: string,          // where the tree is assembled (rpm buildroot / deb data root)
 *   paths: typeof DEFAULT_PATHS,
 *   templatesDir: string,     // the checkout's installers/linux
 *   version: string,          // semver the tarball name carries
 *   bundled: { node?: string, ffmpeg?: string, postgresql?: string },
 *   licensePath: string,      // the repo's LICENSE (AGPL-3.0)
 * }} opts
 * @returns {{ rootDir: string, version: string, units: { name: string, text: string }[], envText: string, inventory: Map<string, number> }}
 */
export function assemblePackageRoot({ payloadDir, rootDir, paths, templatesDir, version, bundled, licensePath }) {
  const versionFile = path.join(payloadDir, "VERSION");
  if (!existsSync(versionFile)) throw new Error(`native-package: ${payloadDir} has no VERSION file — not an extracted Loombre tarball`);
  const payloadVersion = readFileSync(versionFile, "utf8").trim();
  if (payloadVersion !== version) {
    throw new Error(`native-package: the payload's VERSION (${payloadVersion}) disagrees with the tarball name's version (${version})`);
  }
  for (const entry of PAYLOAD_ENTRIES) {
    if (!existsSync(path.join(payloadDir, entry))) throw new Error(`native-package: payload entry ${entry} is missing from ${payloadDir}`);
  }
  for (const rel of ["loombre.env.template", ...SERVICES.map((svc) => `systemd/${svc}.service.template`)]) {
    if (!existsSync(path.join(templatesDir, ...rel.split("/")))) throw new Error(`native-package: template ${rel} is missing from ${templatesDir}`);
  }
  const agplText = readFileSync(licensePath, "utf8");

  rmSync(rootDir, { recursive: true, force: true });
  const inRoot = (absolute) => path.join(rootDir, ...absolute.split("/").filter(Boolean));

  // /opt/loombre — the payload, verbatim (pnpm's node_modules symlinks
  // preserved as symlinks; timestamps kept for reproducible packaging).
  const prefixDir = inRoot(paths.prefix);
  mkdirSync(prefixDir, { recursive: true });
  for (const entry of PAYLOAD_ENTRIES) {
    cpSync(path.join(payloadDir, entry), path.join(prefixDir, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: false, force: true });
  }
  // Never ship the writable cache dir (the scriptlets create it, owned by
  // the service user); build-tarball.mjs strips it too, but be certain.
  rmSync(inRoot(paths.webCacheDir), { recursive: true, force: true });
  chmodTreeGoMinusW(prefixDir);
  chmodSync(prefixDir, 0o755);

  // The env-file DEFAULT, rendered from the same template install.sh
  // renders — shipped under /usr/share; the scriptlets copy it into
  // /etc/loombre/loombre.env only when that file is absent (see the header).
  const envText = renderEnvFile(readFileSync(path.join(templatesDir, "loombre.env.template"), "utf8"), paths);
  writeFile(inRoot(paths.envDefault), envText, 0o644);
  chmodSync(inRoot(paths.shareDir), 0o755);
  // /etc/loombre exists (package-owned, empty) so the scriptlet's copy and
  // an operator's pre-install restore both have somewhere to land.
  mkdirSync(inRoot(paths.configDir), { recursive: true });
  chmodSync(inRoot(paths.configDir), 0o755);

  // systemd units — same templates, same placeholders as install.sh.
  const units = SERVICES.map((svc) => {
    const text = renderUnit(readFileSync(path.join(templatesDir, "systemd", `${svc}.service.template`), "utf8"), paths);
    writeFile(inRoot(`${paths.unitDir}/${svc}.service`), text, 0o644);
    return { name: `${svc}.service`, text };
  });

  writeFile(inRoot(paths.sysusersFile), sysusersConf(paths), 0o644);

  // /usr/bin/loombre -> /opt/loombre/bin/loombre (absolute: it crosses
  // top-level directories; bin/loombre readlink -f's itself, see LAYOUT.md).
  const binLink = inRoot(paths.binLink);
  mkdirSync(path.dirname(binLink), { recursive: true });
  symlinkSync(`${paths.prefix}/bin/loombre`, binLink);

  // /var/lib/loombre — empty; ownership is applied by the packagers
  // (rpm %attr / deb postinst statoverride) since a build host has no `loombre` uid.
  mkdirSync(inRoot(paths.dataDir), { recursive: true });
  chmodSync(inRoot(paths.dataDir), 0o750);

  const inventory = licenseInventory(prefixDir);
  const pgLicensePath = path.join(prefixDir, ...payloadPgRelative(payloadDir).split("/"), "LICENSE");
  const postgresqlText = existsSync(pgLicensePath) ? readFileSync(pgLicensePath, "utf8") : "";
  writeFile(inRoot(`${paths.docDir}/copyright`), copyrightText({ version, bundled, inventory, agplText, postgresqlText }), 0o644);
  chmodSync(inRoot(paths.docDir), 0o755);
  writeFile(inRoot(`${paths.licenseDir}/LICENSE`), agplText, 0o644);
  chmodSync(inRoot(paths.licenseDir), 0o755);

  return { rootDir, version, units, envText, inventory };
}

// ─────────────────────────────────────────────────────────────────────────
// Scriptlet building blocks shared by both formats (POSIX sh)
// ─────────────────────────────────────────────────────────────────────────

function indent(lines, by = "  ") {
  return lines.map((l) => (l === "" ? l : `${by}${l}`));
}

function unitList(order = SERVICES) {
  return order.map((svc) => `${svc}.service`).join(" ");
}

const n = PACKAGE_META.name;

/** The tarball-coexistence guard: on a FRESH install (never on upgrades or
 *  a reinstall after a plain remove), a REGULAR unit file in
 *  /etc/systemd/system (the tarball channel's install.sh writes one; a
 *  symlink there is deb-systemd-helper's mask, or an admin's) or a payload
 *  at /opt/loombre means an unpackaged Loombre is present. Abort before any
 *  file is written. No rpm/dpkg queries: the database is mid-transaction. */
function coexistenceGuardLines(paths, indent) {
  const i = indent;
  const unit = "/etc/systemd/system/loombre-server.service";
  return [
    `${i}_foreign=""`,
    `${i}if [ -e ${paths.prefix}/VERSION ]; then`,
    `${i}  _foreign="${paths.prefix}/VERSION"`,
    `${i}elif [ -f ${unit} ] && [ ! -L ${unit} ] && ! grep -q "^ExecStart=${paths.prefix}/" ${unit} 2>/dev/null; then`,
    `${i}  # A regular unit in /etc whose ExecStart is NOT under ${paths.prefix}: a tarball`,
    `${i}  # installed with --prefix elsewhere (an admin's \`systemctl edit --full\` copy of`,
    `${i}  # the packaged unit points into ${paths.prefix} and only gets a warning later).`,
    `${i}  _foreign="${unit}"`,
    `${i}fi`,
    `${i}if [ -n "$_foreign" ]; then`,
    `${i}  echo "${n}: an unpackaged (tarball) Loombre install is present ($_foreign)." >&2`,
    `${i}  echo "${n}: back up ${paths.envFile}, run that install's uninstall.sh (it keeps ${paths.dataDir}), restore the env file, then install this package — see docs/install/linux.md." >&2`,
    `${i}  exit 1`,
    `${i}fi`,
  ];
}

/** Create the service account, adopting the ORPHANED uid/gid that still
 *  owns an existing data dir (the tarball's uninstall.sh deletes the user
 *  but keeps /var/lib/loombre) so the surviving PostgreSQL cluster stays
 *  readable without a recursive chown. A uid/gid that belongs to a live
 *  account is never taken; the post-install step then re-owns the tree. */
function createUserLines(paths, { rpm }) {
  const groupAdd = rpm
    ? `groupadd -r \${_adopt_gid:+-g "$_adopt_gid"} ${paths.group} || exit 1`
    : `addgroup --quiet --system \${_adopt_gid:+--gid "$_adopt_gid"} ${paths.group}`;
  const userAdd = rpm
    ? `useradd -r \${_adopt_uid:+-u "$_adopt_uid"} -g ${paths.group} -d ${paths.dataDir} -s /sbin/nologin -c "Loombre media server" ${paths.user} || exit 1`
    : `adduser --quiet --system \${_adopt_uid:+--uid "$_adopt_uid"} --ingroup ${paths.group} --home ${paths.dataDir} --no-create-home --shell /usr/sbin/nologin --gecos "Loombre media server" ${paths.user}`;
  return [
    '_adopt_uid=""',
    '_adopt_gid=""',
    `if [ -d ${paths.dataDir} ] && ! getent passwd ${paths.user} >/dev/null; then`,
    `  _owner_uid=$(stat -c %u ${paths.dataDir} 2>/dev/null || echo 0)`,
    `  _owner_gid=$(stat -c %g ${paths.dataDir} 2>/dev/null || echo 0)`,
    '  if [ "$_owner_uid" != "0" ] && ! getent passwd "$_owner_uid" >/dev/null; then _adopt_uid="$_owner_uid"; fi',
    '  if [ "$_owner_gid" != "0" ] && ! getent group "$_owner_gid" >/dev/null; then _adopt_gid="$_owner_gid"; fi',
    "fi",
    `if ! getent group ${paths.group} >/dev/null; then`,
    `  ${groupAdd}`,
    "fi",
    `if ! getent passwd ${paths.user} >/dev/null; then`,
    `  ${userAdd}`,
    "fi",
  ];
}

/** Post-install ownership repair: when the data dir survived a previous
 *  install under a uid the guard could not adopt (it belongs to another
 *  account), re-own it before anything starts. Top-level ownership alone
 *  is not proof — the package manager sets that itself. */
function reownDataDirLines(paths, orElse) {
  return [
    `if [ -d ${paths.dataDir} ] && [ -n "$(find ${paths.dataDir} -mindepth 1 -maxdepth 1 ! -user ${paths.user} -print -quit 2>/dev/null)" ]; then`,
    `  echo "${n}: re-owning ${paths.dataDir} to ${paths.user} (a previous install left it under another account)"`,
    `  chown -R ${paths.user}:${paths.group} ${paths.dataDir} ${orElse}`,
    "fi",
  ];
}

function envFileLines(paths, orElse) {
  return [
    `if [ ! -e ${paths.envFile} ]; then`,
    `  cp ${paths.envDefault} ${paths.envFile} || echo "${n}: WARNING: could not create ${paths.envFile} from ${paths.envDefault}" >&2`,
    "fi",
    `chown root:${paths.group} ${paths.envFile} ${orElse}`,
    `chmod 0640 ${paths.envFile} ${orElse}`,
  ];
}

function startedMessageLines(indent) {
  return [
    `${indent}echo "${n}: services enabled and started."`,
    `${indent}echo "${n}: web UI    -> http://localhost:3000"`,
    `${indent}echo "${n}: API       -> http://localhost:3001"`,
    `${indent}echo "${n}: status    -> systemctl status ${SERVICES.join(" ")}"`,
    `${indent}echo "${n}: first boot provisions + migrates the bundled database; give it a few seconds."`,
  ];
}

function manualStartLines(paths, indent) {
  return [
    `${indent}echo "${n}: systemd is not running here (container/chroot) — units installed and enabled, nothing started. Start manually:"`,
    ...SERVICES.map((svc) => `${indent}echo "  sudo -u ${paths.user} env \\$(grep -v '^#' ${paths.envFile} | xargs) ${paths.prefix}/bin/${svc}"`),
  ];
}

function noAutostartLines(paths, indent) {
  return [
    `${indent}rm -f ${paths.noAutostartFlag}`,
    `${indent}echo "${n}: ${paths.noAutostartFlag} was present — services enabled but NOT started (flag consumed). Edit ${paths.envFile}, then:"`,
    `${indent}echo "  sudo systemctl start ${SERVICES.join(" ")}"`,
  ];
}

/** Remove the scriptlet-created cache dir and the now-empty chain up to
 *  /opt/loombre — an EXPLICIT chain (never `rmdir -p`, which would walk on
 *  into /opt itself). */
function removePayloadLeftoversLines(paths, indent, orElse) {
  const chain = [];
  let dir = path.posix.dirname(paths.webCacheDir);
  while (dir.startsWith(paths.prefix)) {
    chain.push(dir);
    if (dir === paths.prefix) break;
    dir = path.posix.dirname(dir);
  }
  return [
    `${indent}rm -rf ${paths.webCacheDir}`,
    ...chain.map((d) => `${indent}rmdir ${d} >/dev/null 2>&1 ${orElse}`),
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// rpm spec
// ─────────────────────────────────────────────────────────────────────────

const RPM_MARKER = "/run/loombre-rpm-upgrade";

/** The scriptlets, as POSIX sh. Every systemctl call is `|| :` — a package
 *  must install inside a container/chroot with no PID-1 systemd — and the
 *  start/stop branches are additionally gated on a live systemd
 *  (/run/systemd/system); `systemctl enable` is offline-safe (it only writes
 *  symlinks) and runs regardless, so an image built in a chroot boots with
 *  the units enabled. Arguments: %pre/%post get 1 on a fresh install and
 *  >= 2 on an upgrade; %preun/%postun get 0 on erase and >= 1 on an upgrade
 *  (rpm-scriptlets(7)); %posttrans gets nothing useful, hence the marker. */
function rpmScriptlets(paths) {
  const pre = [
    "# $1 == 1: fresh install; $1 >= 2: upgrade (rpm-scriptlets(7))",
    `rm -f ${RPM_MARKER}`,
    'if [ "$1" -eq 1 ]; then',
    ...coexistenceGuardLines(paths, "  "),
    "fi",
    ...createUserLines(paths, { rpm: true }),
    'if [ "$1" -ge 2 ] && [ -d /run/systemd/system ]; then',
    "  # Stop-before-unpack: record what is running, then stop it; %%posttrans",
    "  # (the NEW package's last word, after the old files are gone) starts",
    "  # exactly those units again. /run is tmpfs — no stale marker survives",
    "  # a reboot, and a fresh install clears one left by a failed upgrade.",
    `  for _u in ${unitList(STOP_ORDER)}; do`,
    `    if systemctl is-active --quiet "$_u" 2>/dev/null; then echo "$_u" >> ${RPM_MARKER}; fi`,
    "  done",
    `  if [ -s ${RPM_MARKER} ]; then`,
    `    systemctl stop ${unitList(STOP_ORDER)} >/dev/null 2>&1 || :`,
    "  fi",
    "fi",
    "exit 0",
  ];
  const post = [
    "# $1 == 1: fresh install; $1 >= 2: upgrade",
    "# The ONE writable spot inside the read-only payload (the loombre-web unit's",
    "# ReadWritePaths) — created here, owned by the service user, never shipped.",
    `mkdir -p ${paths.webCacheDir} || :`,
    `chown ${paths.user}:${paths.group} ${paths.webCacheDir} || :`,
    `chmod 0755 ${paths.webCacheDir} || :`,
    ...reownDataDirLines(paths, `|| echo "${n}: WARNING: chown -R failed — fix ownership of ${paths.dataDir} before starting" >&2`),
    ...envFileLines(paths, "|| :"),
    "systemctl daemon-reload >/dev/null 2>&1 || :",
    'if [ "$1" -eq 1 ]; then',
    `  systemctl enable ${unitList()} >/dev/null 2>&1 || :`,
    "  if [ -d /run/systemd/system ]; then",
    `    if [ -e ${paths.noAutostartFlag} ]; then`,
    ...noAutostartLines(paths, "      "),
    "    else",
    `      systemctl start ${unitList()} >/dev/null 2>&1 || :`,
    ...startedMessageLines("      "),
    "    fi",
    "  else",
    ...manualStartLines(paths, "    "),
    "  fi",
    "fi",
    "if [ -f /etc/systemd/system/loombre-server.service ] && [ ! -L /etc/systemd/system/loombre-server.service ]; then",
    `  echo "${n}: NOTE: /etc/systemd/system/loombre-server.service exists and shadows the packaged unit (systemctl cat loombre-server); prefer 'systemctl edit loombre-server' drop-ins, which survive upgrades." >&2`,
    "fi",
    "exit 0",
  ];
  const preun = [
    "# $1 == 0: erase; $1 >= 1: upgrade (the new package's %%pre already stopped the units)",
    'if [ "$1" -eq 0 ]; then',
    "  if [ -d /run/systemd/system ]; then",
    `    systemctl --no-reload disable --now ${unitList(STOP_ORDER)} >/dev/null 2>&1 || :`,
    "  fi",
    "fi",
    "exit 0",
  ];
  const postun = [
    "# $1 == 0: erase; $1 >= 1: upgrade",
    "systemctl daemon-reload >/dev/null 2>&1 || :",
    'if [ "$1" -eq 0 ]; then',
    "  # The runtime cache dir is created by %%post (unowned content), so rpm could",
    "  # not remove it or its now-empty parents; finish the job. The data dir, the",
    "  # env file and the service user are deliberately KEPT (Fedora packaging",
    "  # guideline: a uid may still own files; the library database is the",
    "  # operator's).",
    ...removePayloadLeftoversLines(paths, "  ", "|| :"),
    `  echo "${n}: removed. Kept: ${paths.dataDir} (your library database and caches), ${paths.envFile}, and the '${paths.user}' user."`,
    `  echo "${n}: for a clean slate: rm -rf ${paths.dataDir} ${paths.configDir} && userdel ${paths.user}"`,
    "fi",
    "exit 0",
  ];
  const posttrans = [
    "# Runs last, from the NEW package, after the old package's files are gone.",
    `if [ -f ${RPM_MARKER} ]; then`,
    `  _units=$(cat ${RPM_MARKER})`,
    `  rm -f ${RPM_MARKER}`,
    '  if [ -d /run/systemd/system ] && [ -n "$_units" ]; then',
    "    systemctl daemon-reload >/dev/null 2>&1 || :",
    "    # shellcheck disable=SC2086 — one unit name per word, by construction",
    "    systemctl start $_units >/dev/null 2>&1 || :",
    "  fi",
    "fi",
    "exit 0",
  ];
  return { pre, post, preun, postun, posttrans };
}

/**
 * @param {{
 *   meta: typeof PACKAGE_META, paths: typeof DEFAULT_PATHS,
 *   version: string, rpmVersion: string, release: string,
 *   requires: string[], bundled: { node?: string, ffmpeg?: string, postgresql?: string },
 *   licenseExpression?: string,
 * }} opts
 */
export function renderRpmSpec({ meta, paths, version, rpmVersion, release, requires, bundled, licenseExpression }) {
  const s = rpmScriptlets(paths);
  const lines = [
    `# Loombre ${version} — generated by installers/linux/build-rpm.mjs; do not edit by hand.`,
    "#",
    "# Binary-only spec: the buildroot is pre-populated from the release tarball",
    "# (installers/linux/lib/native-package.mjs assemblePackageRoot), so there is",
    "# no %%prep/%%build/%%install — and %%__spec_install_pre is disabled because",
    "# rpm's default would rm -rf that pre-populated buildroot. (rpm expands",
    "# macros inside comments too, hence the doubled percent signs here.)",
    "",
    "%global debug_package %{nil}",
    "%global __os_install_post %{nil}",
    "%undefine __brp_mangle_shebangs",
    "%global __brp_check_rpaths %{nil}",
    "%global _build_id_links none",
    "%global _missing_build_ids_terminate_build 0",
    "%global __spec_install_pre %{nil}",
    "%global _binary_filedigest_algorithm 8",
    "%define _binary_payload w6T0.xzdio",
    "",
    `Name:           ${meta.name}`,
    `Version:        ${rpmVersion}`,
    `Release:        ${release}`,
    `Summary:        ${meta.summary}`,
    `License:        ${licenseExpression ?? meta.licenseHead.join(" AND ")}`,
    `URL:            ${meta.homepage}`,
    `Vendor:         ${meta.vendor}`,
    `Packager:       ${meta.maintainer}`,
    `Group:          ${meta.rpmGroup}`,
    "",
    "# Dependencies are DERIVED from the payload's ELF files at build time",
    "# (installers/linux/lib/elf-deps.mjs) and listed explicitly; rpm's own",
    "# generators are off because they would also require every node_modules",
    "# shebang interpreter, PROVIDE the bundled libpq/libvips to other",
    "# packages, and require libpython via PostgreSQL's optional plpython3.",
    "# systemd is deliberately NOT required: every scriptlet tolerates its",
    "# absence, so a container or chroot install stays lean.",
    "#",
    "# AutoReq off; AutoProv ON with /opt excluded: rpm >= 4.19 adds",
    "# Requires(pre): user(loombre)/group(loombre) for %%attr owners at build",
    "# time, and only its Provides generator (reading /usr/lib/sysusers.d/",
    "# loombre.conf) can satisfy them — while the exclusion keeps the bundled",
    "# libpq/libvips from ever being offered to other packages.",
    "AutoReq:        no",
    "AutoProv:       yes",
    "%global __provides_exclude_from ^/opt/loombre/.*$",
    ...requires.map((r) => `Requires:       ${r}`),
    "# useradd/groupadd: shadow-utils on Fedora/RHEL, shadow on openSUSE",
    "# (a package name, not a file path — Fedora 42+ merged /usr/sbin into",
    "# /usr/bin and file-path Provides for the old paths are not guaranteed).",
    "Requires(pre):  (shadow-utils or shadow)",
    `Provides:       bundled(nodejs) = ${bundled.node ?? "0"}`,
    `Provides:       bundled(ffmpeg) = ${bundled.ffmpeg ?? "0"}`,
    `Provides:       bundled(postgresql) = ${bundled.postgresql ?? "0"}`,
    "",
    "%description",
    ...meta.description,
    "",
    "%pre",
    ...s.pre,
    "",
    "%post",
    ...s.post,
    "",
    "%preun",
    ...s.preun,
    "",
    "%postun",
    ...s.postun,
    "",
    "%posttrans",
    ...s.posttrans,
    "",
    "%files",
    "%defattr(-,root,root,-)",
    "# The payload, recursively — ONE entry. Never per-file: Next.js ships",
    "# directories literally named [id], which rpm would expand as globs.",
    paths.prefix,
    `%ghost %dir %attr(0755,${paths.user},${paths.group}) ${paths.webCacheDir}`,
    `%dir %attr(0750,${paths.user},${paths.group}) ${paths.dataDir}`,
    `%dir ${paths.configDir}`,
    `%dir ${paths.shareDir}`,
    paths.envDefault,
    ...SERVICES.map((svc) => `${paths.unitDir}/${svc}.service`),
    paths.sysusersFile,
    paths.binLink,
    `%dir ${paths.docDir}`,
    `%doc ${paths.docDir}/copyright`,
    `%dir ${paths.licenseDir}`,
    `%license ${paths.licenseDir}/LICENSE`,
    "",
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// deb control + maintainer scripts
// ─────────────────────────────────────────────────────────────────────────

function wrapDescription(lines) {
  // Debian Policy 5.6.13: continuation lines start with a single space, a
  // blank line is " .", nothing wider than 80 columns.
  const out = [];
  for (const raw of lines) {
    if (raw === "") {
      out.push(" .");
      continue;
    }
    let line = raw;
    while (line.length > 78) {
      let cut = line.lastIndexOf(" ", 78);
      if (cut <= 0) cut = 78;
      out.push(` ${line.slice(0, cut)}`);
      line = line.slice(cut).trimStart();
    }
    out.push(` ${line}`);
  }
  return out;
}

/**
 * @param {{ meta: typeof PACKAGE_META, debVersion: string, debArch: string, depends: string[], installedSizeKb: number }} opts
 */
export function renderDebControl({ meta, debVersion, debArch, depends, installedSizeKb }) {
  // adduser is used by postinst (Policy 7.2: Depends, not Pre-Depends).
  // init-system-helpers is Essential on every supported release, so it is
  // neither listed nor versioned (lintian: depends-on-essential-package…).
  const allDepends = [...new Set([...depends, "adduser"])];
  return [
    `Package: ${meta.name}`,
    `Version: ${debVersion}`,
    `Architecture: ${debArch}`,
    `Maintainer: ${meta.maintainer}`,
    `Installed-Size: ${Math.max(1, Math.round(installedSizeKb))}`,
    `Depends: ${allDepends.join(", ")}`,
    `Section: ${meta.debSection}`,
    "Priority: optional",
    `Homepage: ${meta.homepage}`,
    `Description: ${meta.summary}`,
    ...wrapDescription(meta.description),
    "",
  ].join("\n");
}

const DEB_MARKER = "/run/loombre-deb-upgrade";

/** Debian maintainer scripts (Policy chapter 6). POSIX sh, `set -e`, and
 *  every service-manager call `|| true` so a host without systemd (an LXC
 *  container, a chroot) still installs — the same posture as install.sh's
 *  --no-systemd. deb-systemd-helper / deb-systemd-invoke (init-system-helpers,
 *  Essential) are used the way dh_installsystemd's snippets use them: enable
 *  respects the admin's recorded enablement state; deb-systemd-invoke
 *  honours policy-rc.d and never starts a disabled or masked unit. */
export function renderDebMaintainerScripts({ paths }) {
  const units = unitList();
  const stopOrder = unitList(STOP_ORDER);
  const preinst = [
    "#!/bin/sh",
    "set -e",
    "# $1: install | upgrade | abort-upgrade; $2: the most recently configured version",
    "#     (empty on a first install; SET on a reinstall after a plain remove)",
    'if [ "$1" = "install" ] && [ -z "$2" ]; then',
    ...coexistenceGuardLines(paths, "  "),
    "fi",
    "exit 0",
    "",
  ].join("\n");

  const postinst = [
    "#!/bin/sh",
    "set -e",
    "# $1: configure | abort-upgrade | abort-remove | abort-deconfigure",
    "# $2: the most recently configured version — empty on a FIRST install only;",
    "#     set on an upgrade AND on a reinstall after a plain remove (config-files",
    "#     state), so start/enable decisions never key on it alone.",
    'if [ "$1" = "configure" ]; then',
    ...indent(createUserLines(paths, { rpm: false })),
    "  # dpkg unpacks everything root-owned (dpkg-deb --root-owner-group); the",
    "  # service user's ownership is recorded with dpkg-statoverride (Policy",
    "  # 10.9) so dpkg re-applies it on every unpack and an operator's own",
    "  # override wins over ours.",
    `  mkdir -p ${paths.dataDir}`,
    `  if ! dpkg-statoverride --list ${paths.dataDir} >/dev/null 2>&1; then`,
    `    dpkg-statoverride --update --add ${paths.user} ${paths.group} 0750 ${paths.dataDir}`,
    "  fi",
    `  mkdir -p ${paths.webCacheDir}`,
    `  if ! dpkg-statoverride --list ${paths.webCacheDir} >/dev/null 2>&1; then`,
    `    dpkg-statoverride --update --add ${paths.user} ${paths.group} 0755 ${paths.webCacheDir}`,
    "  fi",
    ...indent(reownDataDirLines(paths, `|| echo "${n}: WARNING: chown -R failed — fix ownership of ${paths.dataDir} before starting" >&2`)),
    ...indent(envFileLines(paths, "|| true")),
    "  # Enablement is offline-safe (symlinks only) and runs regardless of a live",
    "  # systemd, so an image built in a chroot boots with the units enabled.",
    "  if command -v deb-systemd-helper >/dev/null 2>&1; then",
    `    deb-systemd-helper unmask ${units} >/dev/null || true`,
    `    for _u in ${units}; do`,
    '      if deb-systemd-helper debian-installed "$_u"; then',
    '        if deb-systemd-helper --quiet was-enabled "$_u"; then',
    '          deb-systemd-helper enable "$_u" >/dev/null || true',
    "        else",
    '          deb-systemd-helper update-state "$_u" >/dev/null || true',
    "        fi",
    "      else",
    '        deb-systemd-helper enable "$_u" >/dev/null || true',
    "      fi",
    "    done",
    "  else",
    `    systemctl enable ${units} >/dev/null 2>&1 || true`,
    "  fi",
    "  if [ -d /run/systemd/system ]; then",
    "    systemctl daemon-reload >/dev/null 2>&1 || true",
    `    if [ -f ${DEB_MARKER} ]; then`,
    "      # Upgrade: prerm recorded what was running and stopped it; start exactly that.",
    `      _units=$(cat ${DEB_MARKER})`,
    `      rm -f ${DEB_MARKER}`,
    '      if [ -n "$_units" ]; then',
    "        # shellcheck disable=SC2086 — one unit name per word, by construction",
    "        deb-systemd-invoke start $_units >/dev/null || true",
    "      fi",
    `    elif [ -e ${paths.noAutostartFlag} ]; then`,
    ...noAutostartLines(paths, "      "),
    "    else",
    "      # First install, or a reinstall after a plain remove (prerm stopped the",
    "      # units then). deb-systemd-invoke skips disabled/masked units itself.",
    `      deb-systemd-invoke start ${units} >/dev/null || true`,
    ...startedMessageLines("      "),
    "    fi",
    "  else",
    ...manualStartLines(paths, "    "),
    "  fi",
    "  if [ -f /etc/systemd/system/loombre-server.service ] && [ ! -L /etc/systemd/system/loombre-server.service ]; then",
    `    echo "${n}: NOTE: /etc/systemd/system/loombre-server.service exists and shadows the packaged unit (systemctl cat loombre-server); prefer 'systemctl edit loombre-server' drop-ins, which survive upgrades." >&2`,
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");

  const prerm = [
    "#!/bin/sh",
    "set -e",
    "# $1: remove | upgrade | deconfigure | failed-upgrade",
    'case "$1" in',
    '  "remove")',
    "    if [ -d /run/systemd/system ]; then",
    `      deb-systemd-invoke stop ${stopOrder} >/dev/null || true`,
    "    fi",
    "    ;;",
    '  "upgrade")',
    "    # Stop-before-unpack: record what is running, then stop it; the new",
    "    # package's postinst starts exactly those units again (see the header",
    "    # of installers/linux/lib/native-package.mjs for why not restart-after).",
    `    rm -f ${DEB_MARKER}`,
    "    if [ -d /run/systemd/system ]; then",
    `      for _u in ${stopOrder}; do`,
    `        if systemctl is-active --quiet "$_u" 2>/dev/null; then echo "$_u" >> ${DEB_MARKER}; fi`,
    "      done",
    `      if [ -s ${DEB_MARKER} ]; then`,
    `        deb-systemd-invoke stop ${stopOrder} >/dev/null || true`,
    "      fi",
    "    fi",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const postrm = [
    "#!/bin/sh",
    "set -e",
    "# $1: remove | purge | upgrade | failed-upgrade | abort-install | abort-upgrade | disappear",
    'case "$1" in',
    '  "remove")',
    "    # dpkg keeps the data dir and the (script-managed) env file until purge;",
    "    # the runtime cache dir is postinst-created content dpkg does not own.",
    ...removePayloadLeftoversLines(paths, "    ", "|| true"),
    "    if [ -d /run/systemd/system ]; then",
    "      systemctl daemon-reload >/dev/null 2>&1 || true",
    "    fi",
    "    if command -v deb-systemd-helper >/dev/null 2>&1; then",
    `      deb-systemd-helper mask ${units} >/dev/null || true`,
    "    fi",
    `    echo "${n}: removed. Kept until purge: ${paths.dataDir} (your library database and caches), ${paths.configDir}, and the '${paths.user}' user."`,
    "    ;;",
    '  "purge")',
    "    if command -v deb-systemd-helper >/dev/null 2>&1; then",
    `      deb-systemd-helper purge ${units} >/dev/null || true`,
    `      deb-systemd-helper unmask ${units} >/dev/null || true`,
    "    fi",
    `    dpkg-statoverride --remove ${paths.dataDir} >/dev/null 2>&1 || true`,
    `    dpkg-statoverride --remove ${paths.webCacheDir} >/dev/null 2>&1 || true`,
    "    # A separately mounted data volume is the operator's, not the package's.",
    `    if mountpoint -q ${paths.dataDir} 2>/dev/null; then`,
    `      echo "${n}: ${paths.dataDir} is a mount point — leaving its contents alone." >&2`,
    "    else",
    `      rm -rf ${paths.dataDir}`,
    "    fi",
    `    rm -rf ${paths.configDir}`,
    ...removePayloadLeftoversLines(paths, "    ", "|| true"),
    `    if getent passwd ${paths.user} >/dev/null; then`,
    `      deluser --quiet --system ${paths.user} >/dev/null 2>&1 || echo "${n}: user '${paths.user}' not removed (still running a process?)" >&2`,
    "    fi",
    `    if getent group ${paths.group} >/dev/null; then`,
    `      delgroup --quiet --system ${paths.group} >/dev/null 2>&1 || true`,
    "    fi",
    `    echo "${n}: purged — nothing of Loombre remains."`,
    "    ;;",
    "  *)",
    "    if [ -d /run/systemd/system ]; then",
    "      systemctl daemon-reload >/dev/null 2>&1 || true",
    "    fi",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  return { preinst, postinst, prerm, postrm };
}

/** DEBIAN/md5sums — what dpkg -V and debsums verify against (dpkg-deb does
 *  not generate it; dh_md5sums does in debhelper builds). Every regular
 *  file in the data tree, paths relative without a leading slash. */
export function debMd5sums(rootDir) {
  const lines = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (dir === rootDir && entry.name === "DEBIAN") continue;
      const st = lstatSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) {
        const rel = path.relative(rootDir, full).split(path.sep).join("/");
        lines.push(`${createHash("md5").update(readFileSync(full)).digest("hex")}  ${rel}`);
      }
    }
  }
  return `${lines.sort((a, b) => (a.slice(34) < b.slice(34) ? -1 : 1)).join("\n")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────
// Tooling helpers shared by the two builders
// ─────────────────────────────────────────────────────────────────────────

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** dpkg's Installed-Size: disk usage in KiB (du -k -s style — file sizes
 *  rounded up to 1 KiB blocks plus a block per directory). An estimate by
 *  definition; only apt's "additional disk space" message reads it. */
export function treeSizeKb(root) {
  let kb = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    kb += 4;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isDirectory()) stack.push(full);
      else kb += Math.ceil(st.size / 1024);
    }
  }
  return kb;
}

/** Extract a release tarball (preserving modes: `-p`, since a non-root
 *  extraction otherwise applies the umask) and return the payload dir. */
export function extractTarball(tarballPath, extractDir) {
  const { name } = parseTarballName(tarballPath);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const res = spawnSync("tar", ["-xzpf", tarballPath, "-C", extractDir], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`native-package: tar -xzpf ${tarballPath} failed (exit ${res.status})`);
  const payloadDir = path.join(extractDir, name);
  if (!existsSync(path.join(payloadDir, "VERSION"))) throw new Error(`native-package: ${tarballPath} did not extract to ${name}/VERSION`);
  return payloadDir;
}

function which(tool) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [tool], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

/**
 * Decide how to run a packer (`rpmbuild` / `dpkg-deb`): natively when on
 * PATH, else inside the pinned PACKER_IMAGE via docker, else fail with the
 * exact remedy.
 *
 * @param {string} tool
 * @param {{ mode?: "auto" | "native" | "docker" }} [opts]
 * @returns {{ kind: "native", path: string } | { kind: "docker", image: string }}
 */
export function resolvePacker(tool, opts = {}) {
  const mode = opts.mode ?? "auto";
  const native = mode === "docker" ? null : which(tool);
  if (native) return { kind: "native", path: native };
  if (mode === "native") throw new Error(`native-package: ${tool} is not on PATH and --packer native was requested`);
  if (which("docker")) return { kind: "docker", image: PACKER_IMAGE };
  throw new Error(
    `native-package: neither ${tool} nor docker is available. Install ${tool} (Fedora: dnf install rpm-build; Debian/Ubuntu: apt install rpm dpkg-dev; macOS: brew install rpm dpkg) or start Docker (the build then runs ${tool} inside ${PACKER_IMAGE}).`,
  );
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a packer command. In docker mode `workDir` is bind-mounted at /work
 * and every path argument the caller supplies must already be expressed
 * relative to that mount (the builders do this via `pathFor`).
 *
 * @param {{ kind: "native" | "docker", image?: string }} packer
 * @param {{ tool: string, args: string[], workDir: string, prepare?: string }} cmd
 */
export function runPacker(packer, { tool, args, workDir, prepare }) {
  if (packer.kind === "native") {
    const res = spawnSync(tool, args, { stdio: "inherit", cwd: workDir });
    if (res.status !== 0) throw new Error(`native-package: ${tool} exited ${res.status}`);
    return;
  }
  if (workDir.includes(",")) throw new Error(`native-package: docker --mount cannot express a path containing ',' (${workDir})`);
  const script = [prepare, [tool, ...args].map(shellQuote).join(" ")].filter(Boolean).join(" && ");
  const res = spawnSync(
    "docker",
    ["run", "--rm", "--mount", `type=bind,src=${workDir},dst=/work`, "-w", "/work", packer.image, "bash", "-c", script],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`native-package: ${tool} (inside ${packer.image}) exited ${res.status}`);
}
