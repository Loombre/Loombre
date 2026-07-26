// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/crash/fixtures/throw-entrypoint.ts
//
// Deliberately minimal, real child-process entrypoint for
// forced-crash.integration.spec.ts: installs the REAL crash handlers, then
// deliberately crashes. Never imported by anything except that one spec —
// this is fixture code, not shipped src.
//
// Usage: node --import tsx throw-entrypoint.ts <dataDir> <throw|reject>

import { installCrashHandlers } from "../../../src/crash/handlers.js";

const [, , dataDir, mode] = process.argv;
if (!dataDir || (mode !== "throw" && mode !== "reject")) {
  console.error("usage: throw-entrypoint.ts <dataDir> <throw|reject>");
  process.exit(2);
}

installCrashHandlers({ dataDir, version: "test-fixture-1.0.0", platform: process.platform });

if (mode === "throw") {
  throw new Error(`forced crash for integration test — path leak check: ${import.meta.url}`);
} else {
  void Promise.reject(new Error("forced unhandled rejection for integration test"));
}
