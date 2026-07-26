#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/sign-hook.mjs
//
// SHARED deliverable (every platform's build script calls this as its last
// step — installers/linux/build-tarball.mjs today, installers/windows and
// installers/macos in lanes I3/I4). STATE.md P4.1 / docs/PLAN.md §11:
// Loombre ships UNSIGNED in v1 (no Authenticode, no Apple notarization —
// see docs/install/linux.md's verification section for the checksum +
// minisign trust model that stands in for platform code-signing), but the
// release pipeline keeps a clean signing INSERTION POINT so adding real
// certificates later is a pipeline PR, not a rework (P4.1: "a sign: hook
// per artifact, no-op in v1").
//
// This is that hook. It is intentionally a complete no-op: it does not
// touch the artifact's bytes, does not write a signature file, and always
// exits 0. When real signing lands (owner decision, outside this lane's
// scope), this file's body is what gets replaced — every build script's
// call site (`node installers/sign-hook.mjs <artifact>`) stays identical.
//
// Usage:
//   node installers/sign-hook.mjs <path-to-built-artifact>

import { existsSync } from "node:fs";

export function signHook(artifactPath) {
  if (!artifactPath) {
    throw new Error("sign-hook: missing required <artifact> argument");
  }
  if (!existsSync(artifactPath)) {
    throw new Error(`sign-hook: artifact not found: ${artifactPath}`);
  }
  console.log(`sign-hook: unsigned build (P4.1) — ${artifactPath}`);
  return { signed: false, reason: "P4.1 unsigned posture — no-op hook" };
}

const isDirectEntrypoint = process.argv[1] && process.argv[1].endsWith("sign-hook.mjs");
if (isDirectEntrypoint) {
  try {
    signHook(process.argv[2]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
