// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/msi/services-environment.test.mjs
//
// LD-11 (this implementation run's lane B3): every install shape
// must set LOOMBRE_LOG_FILE to a platform-appropriate path so
// GET /admin/logs/tail (apps/server/src/catalog/admin-logs-tail.ts) has
// something real to read. On Windows, LoombreServiceHost's own log-file
// Arguments flag (see Services.wxs's header on why the flag name is
// spelled out rather than typed literally in XML comments) already writes
// each service's child-process stdout to a real file under
// %ProgramData%\Loombre\logs — this test asserts LOOMBRE_LOG_FILE is wired
// into each service's own Environment REG_MULTI_SZ pointing at that SAME
// path, never a hand-copied second path that could drift from it.
//
// Run: node --test installers/windows/msi/services-environment.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MSI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = path.join(MSI_DIR, "Services.wxs");
const DIRECTORIES_PATH = path.join(MSI_DIR, "Directories.wxs");

const servicesSource = readFileSync(SERVICES_PATH, "utf8");
const directoriesSource = readFileSync(DIRECTORIES_PATH, "utf8");

test("Directories.wxs defines APPDATA_LOGS under the ProgramData\\Loombre root", () => {
  assert.match(directoriesSource, /<Directory\s+Id="APPDATA_LOGS"\s+Name="logs"\s*\/>/);
});

/** Extracts the `Arguments='...'` value for a named ServiceInstall, and the
 *  `Value="..."` of the Environment RegistryValue for the same service Name
 *  — both derived from the real Services.wxs source, never a hand-copied
 *  parallel list, so this test fails the moment either drifts from the
 *  other. */
function extractService(name) {
  const installRe = new RegExp(
    `<ServiceInstall[^>]*Id="svc\\.${name}"[\\s\\S]*?Arguments='([^']*)'`,
  );
  const installMatch = servicesSource.match(installRe);
  assert.ok(installMatch, `could not find ServiceInstall Id="svc.${name}" with an Arguments value`);

  const envRe = new RegExp(
    `Key="SYSTEM\\\\CurrentControlSet\\\\Services\\\\${name}"[\\s\\S]*?Value="([^"]*)"`,
  );
  const envMatch = servicesSource.match(envRe);
  assert.ok(envMatch, `could not find the Environment RegistryValue for Services\\${name}`);

  return { arguments: installMatch[1], environment: envMatch[1] };
}

for (const name of ["LoombreServer", "LoombreWorker", "LoombreWeb"]) {
  test(`${name}: Environment sets LOOMBRE_LOG_FILE to the exact same path as the service's own log-file Arguments flag`, () => {
    const { arguments: args, environment } = extractService(name);

    // The Arguments value spells the flag as two hyphens + "log" (kept out
    // of a literal string here only to mirror this repo's own WIX0104
    // comment convention — Arguments is a real attribute value, not a
    // comment, so the literal flag IS present in the source and safe to
    // match against).
    const logFlagMatch = args.match(/--log "([^"]+)"/);
    assert.ok(logFlagMatch, `${name}'s ServiceInstall Arguments carries no log-file flag: ${args}`);
    const logFlagPath = logFlagMatch[1];

    const envVarMatch = environment.match(/LOOMBRE_LOG_FILE=([^[~\]]*(?:\[[^\]]*\][^[~\]]*)*)/);
    assert.ok(envVarMatch, `${name}'s Environment REG_MULTI_SZ never sets LOOMBRE_LOG_FILE: ${environment}`);
    const envVarPath = envVarMatch[1];

    assert.equal(
      envVarPath,
      logFlagPath,
      `${name}: LOOMBRE_LOG_FILE (${envVarPath}) must match the service host's own log-file flag (${logFlagPath}) — ` +
        "these are two independent literals in the XML and can drift; keep them in sync.",
    );
    assert.match(envVarPath, /^\[APPDATA_LOGS\][a-z]+\.log$/, `${name}'s log path is not under [APPDATA_LOGS]: ${envVarPath}`);
  });
}

test("every service's Environment REG_MULTI_SZ has no trailing [~] after its last entry (MSI null-separator convention)", () => {
  for (const name of ["LoombreServer", "LoombreWorker", "LoombreWeb"]) {
    const { environment } = extractService(name);
    assert.ok(!environment.endsWith("[~]"), `${name}'s Environment value ends with a spurious trailing [~]: ${environment}`);
  }
});
