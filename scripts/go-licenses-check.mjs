#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/go-licenses-check.mjs
//
// RG1/RG14 (STATE.md "Loombre Remote", lane WG1): license-checker (this
// repo's existing npm-graph gate, scripts/license-check.mjs) is
// structurally blind to packages/wg-native/native's Go module graph — this
// script closes that gap the same way scripts/dep-audit.mjs closes the
// production-vs-dev blind spot, using google/go-licenses (pinned v1.6.0,
// the version this gate was verified against — LICENSE-INTENT.md's Go
// components section records the same pin) to walk the ACTUAL compiled
// dependency graph (not the full go.sum module list, which for
// gvisor.dev/gvisor in particular pulls in a much larger "everything this
// module's OTHER packages need" set than what packages/wg-native/native
// actually imports — go-licenses resolves from real package imports, same
// as `go build` would).
//
// The SAME allow-list scripts/license-check.mjs already enforces for the
// npm graph (kept in sync manually — both are short, stable lists; a
// mismatch would be caught by either gate rejecting a license the other
// allows).
//
// Go not installed: graceful, LOUD skip (same require-ffmpeg/require-wg
// posture) — LOOMBRE_REQUIRE_WG=1 escalates to a hard failure. go-licenses
// itself is bootstrapped on demand via `go install` (pinned version, GOPATH/
// bin cached across runs) rather than requiring a separate CI action —
// mirrors how scripts/dep-audit.mjs shells out to a tool already on PATH,
// except here the tool is a `go install`-able Go binary, not an npm dep.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = join(REPO_ROOT, "packages", "wg-native", "native");
const GO_LICENSES_VERSION = "v1.6.0";

// Kept in sync with scripts/license-check.mjs's ALLOW list (that file's own
// comment: "the single source of the allow-list is HERE now" refers to the
// npm graph specifically; this is the Go-graph twin of the same list).
const ALLOWED_LICENSES = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "AGPL-3.0",
  "GPL-3.0",
  "LGPL-3.0",
  "MPL-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "Python-2.0",
  "WTFPL",
].join(",");

const REQUIRE_WG = process.env["LOOMBRE_REQUIRE_WG"] === "1";

function commandAvailable(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function goEnvPath(key) {
  try {
    return execFileSync("go", ["env", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function resolveGoLicensesBinary() {
  if (commandAvailable("go-licenses", ["--help"])) return "go-licenses";

  const gobin = goEnvPath("GOBIN") || join(goEnvPath("GOPATH") || `${process.env["HOME"]}/go`, "bin");
  const candidate = join(gobin, process.platform === "win32" ? "go-licenses.exe" : "go-licenses");
  if (commandAvailable(candidate, ["--help"])) return candidate;

  console.log(`go-licenses-check: go-licenses not found — installing ${GO_LICENSES_VERSION} via 'go install'...`);
  try {
    execFileSync("go", ["install", `github.com/google/go-licenses@${GO_LICENSES_VERSION}`], { stdio: "inherit" });
  } catch (err) {
    console.error(`go-licenses-check: 'go install github.com/google/go-licenses@${GO_LICENSES_VERSION}' failed: ${err.message}`);
    return null;
  }
  return commandAvailable(candidate, ["--help"]) ? candidate : null;
}

function main() {
  if (!commandAvailable("go", ["version"])) {
    const message =
      "go-licenses-check: Go toolchain not found on PATH — skipping the Go dependency-graph license scan " +
      "(packages/wg-native/native). Install Go (https://go.dev/dl/) to run this check locally.";
    if (REQUIRE_WG) {
      console.error(message);
      console.error("go-licenses-check: LOOMBRE_REQUIRE_WG=1 is set — refusing to silently skip.");
      process.exit(1);
    }
    console.warn(message);
    return;
  }

  const binary = resolveGoLicensesBinary();
  if (!binary) {
    if (REQUIRE_WG) {
      console.error("go-licenses-check: could not obtain a working go-licenses binary — LOOMBRE_REQUIRE_WG=1 is set, failing.");
      process.exit(1);
    }
    console.warn("go-licenses-check: could not obtain a working go-licenses binary — skipping.");
    return;
  }

  console.log(`go-licenses-check: scanning packages/wg-native/native's Go dependency graph (allow-list: ${ALLOWED_LICENSES})...`);
  try {
    execFileSync(
      binary,
      ["check", "--ignore", "loombre.dev/wg-native", "--allowed_licenses", ALLOWED_LICENSES, "."],
      { cwd: NATIVE_DIR, stdio: "inherit" },
    );
  } catch (err) {
    console.error(`go-licenses-check: FAILED — a dependency's license is not on the allow-list (${err.message}).`);
    process.exit(1);
  }
  console.log("go-licenses-check: PASS");
}

main();
