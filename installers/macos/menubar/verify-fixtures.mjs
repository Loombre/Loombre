#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/menubar/verify-fixtures.mjs
//
// Validates fixtures.json against @loombre/controller-ipc's REAL Ajv
// schemas (built dist, not hand-copied schema text) — the sync check
// referenced by fixtures.json's header and by
// Tests/LoombreIPCKitTests/Fixtures.swift's header comment. Run this after
// editing either fixtures.json or the Swift copy.
//
// Not part of `pnpm gate` (Swift/menubar tooling is outside the pnpm
// workspace — pnpm-workspace.yaml only globs apps/* and packages/*) — run
// manually, and by installers/macos/build-pkg.mjs before it invokes
// `swift test`, so a drifted fixture fails loudly before the Swift side
// even gets a chance to test against it.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONTROLLER_IPC_DIR = path.join(REPO_ROOT, "packages", "controller-ipc");

// Anchor module resolution at packages/controller-ipc so `ajv` (its own
// devDependency) resolves via pnpm's workspace node_modules, without this
// script needing any dependency of its own.
const require = createRequire(path.join(CONTROLLER_IPC_DIR, "package.json"));
const { default: Ajv } = require("ajv");

const ipc = await import(path.join(CONTROLLER_IPC_DIR, "dist", "index.js"));

const ajv = new Ajv({ strict: true });

/** fixture key -> schema */
const CHECKS = [
  ["discoveryFile", ipc.IPC_DISCOVERY_FILE_SCHEMA],
  ["processInfoRunning", ipc.PROCESS_INFO_SCHEMA],
  ["processInfoStopped", ipc.PROCESS_INFO_SCHEMA],
  ["processInfoCrashed", ipc.PROCESS_INFO_SCHEMA],
  ["statusResponseHealthy", ipc.IPC_STATUS_RESPONSE_SCHEMA],
  ["statusResponseStopped", ipc.IPC_STATUS_RESPONSE_SCHEMA],
  ["statusResponseCrashed", ipc.IPC_STATUS_RESPONSE_SCHEMA],
  ["errorBodyUnauthorized", ipc.IPC_ERROR_BODY_SCHEMA],
  ["errorBodyServerAlreadyRunning", ipc.IPC_ERROR_BODY_SCHEMA],
  ["serverActionResponseAccepted", ipc.IPC_SERVER_ACTION_RESPONSE_SCHEMA],
  ["serverActionResponseNoop", ipc.IPC_SERVER_ACTION_RESPONSE_SCHEMA],
  ["openWebTargetResponse", ipc.OPEN_WEB_TARGET_RESPONSE_SCHEMA],
  ["crashFilesResponse", ipc.CRASH_FILES_RESPONSE_SCHEMA],
  ["crashFilesResponseEmpty", ipc.CRASH_FILES_RESPONSE_SCHEMA],
];

// provisioningStatus* fixtures are checked separately: PROVISIONING_STATUS_SCHEMA
// comes from @loombre/provisioning, re-exported through the status response
// schema's $ref-free inline copy in status.ts, not from the controller-ipc
// barrel directly under its own name — import it straight from the source.
const provisioning = await import(
  path.join(REPO_ROOT, "packages", "provisioning", "dist", "index.js")
);
CHECKS.push(["provisioningStatusExternal", provisioning.PROVISIONING_STATUS_SCHEMA]);
CHECKS.push(["provisioningStatusReady", provisioning.PROVISIONING_STATUS_SCHEMA]);

const fixtures = JSON.parse(readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));

let failed = false;
for (const [key, schema] of CHECKS) {
  if (schema === undefined) {
    console.error(`FAIL ${key}: schema export was undefined (barrel drift?)`);
    failed = true;
    continue;
  }
  const value = fixtures[key];
  if (value === undefined) {
    console.error(`FAIL ${key}: no such fixture in fixtures.json`);
    failed = true;
    continue;
  }
  const validate = ajv.compile(schema);
  const ok = validate(value);
  if (ok) {
    console.log(`ok   ${key}`);
  } else {
    console.error(`FAIL ${key}: ${ajv.errorsText(validate.errors)}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nfixtures.json has drifted from @loombre/controller-ipc's schemas — fix before syncing Fixtures.swift.");
  process.exit(1);
}
console.log(`\n${CHECKS.length} fixtures validate against @loombre/controller-ipc + @loombre/provisioning schemas.`);
