#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray-go.test.mjs
//
// Runs the Linux tray controller's own Go checks (installers/linux/tray —
// gofmt, go vet, go test) from `pnpm installers:test`, the same way the
// Windows tray's dotnet tests and the macOS menubar's swift tests are
// reached from their builders: the tray is a Go module outside the pnpm
// workspace, so nothing in the JS gate would otherwise exercise it.
//
// Go absent: a loud skip, unless LOOMBRE_REQUIRE_WG=1 (CI's posture for the
// other Go component, packages/wg-native — setup-go guarantees Go there),
// which turns the skip into a failure. Mirrors scripts/go-licenses-check.mjs.
//
// Run: node --test installers/linux/tray-go.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TRAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "tray");
const REQUIRE_GO = process.env["LOOMBRE_REQUIRE_WG"] === "1";

function go(args, extraEnv = {}) {
  return spawnSync("go", args, { cwd: TRAY_DIR, encoding: "utf8", env: { ...process.env, ...extraEnv } });
}

const goAvailable = (() => {
  const r = spawnSync("go", ["version"], { encoding: "utf8" });
  return r.error === undefined && r.status === 0;
})();

const skipReason = goAvailable ? false : REQUIRE_GO ? false : "Go toolchain not on PATH (set LOOMBRE_REQUIRE_WG=1 to make this a failure)";
if (!goAvailable && !REQUIRE_GO) console.warn(`tray-go.test: ${skipReason} — skipping installers/linux/tray's Go checks`);

test("installers/linux/tray: the Go module exists", () => {
  assert.ok(existsSync(path.join(TRAY_DIR, "go.mod")), "installers/linux/tray/go.mod is missing");
  assert.ok(existsSync(path.join(TRAY_DIR, "go.sum")), "installers/linux/tray/go.sum is missing (run `go mod tidy` there)");
});

test("installers/linux/tray: Go toolchain present when required", { skip: skipReason }, () => {
  assert.ok(goAvailable, "LOOMBRE_REQUIRE_WG=1 is set but no Go toolchain is on PATH");
});

test("installers/linux/tray: gofmt reports no unformatted files", { skip: skipReason }, () => {
  const r = spawnSync("gofmt", ["-l", "."], { cwd: TRAY_DIR, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "", `gofmt -l lists unformatted files:\n${r.stdout}`);
});

test("installers/linux/tray: go vet is clean", { skip: skipReason }, () => {
  const r = go(["vet", "./..."]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("installers/linux/tray: go test passes (pure decision logic runs on every host OS)", { skip: skipReason }, () => {
  const r = go(["test", "./..."]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("installers/linux/tray: cross-compiles to a static linux/amd64 binary with CGO off (what build-tarball.mjs ships)", { skip: skipReason }, () => {
  const r = go(["build", "-trimpath", "-o", path.join("/dev", "null"), "."], { CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
