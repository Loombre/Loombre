#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/sign-manifest.mjs
//
// LOCAL (off-CI) signing helper — lets the release manager sign a release
// from their own machine without depending on GitHub Actions at all (a
// hotfix cut outside the normal pipeline, keys/README.md's "Local (off-CI)
// signing" section). Shells out to a LOCALLY-INSTALLED `minisign` binary
// if present; if it isn't, this script SKIPS with a clear message and
// exits 0 rather than failing — per this lane's mandate: "local signing
// script may also shell out to a locally-installed minisign IF present,
// else skip-with-message" (no npm minisign dependency exists or ever will;
// see packages/release-manifest/README.md's whole DECISION section).
//
// Signs every file passed on the command line with standard `Ed` mode —
// NEVER `-x` (P4.18: this project verifies "Ed" only, so a secret key
// that ever produces an "ED" prehashed signature would be unverifiable by
// this project's own server). minisign's OWN default IS standard mode
// (no `-x` needed to select it — `-x` is what would need to be added for
// prehashed mode), so this script's only real job re: P4.18 is "never add
// -x", which the args list below makes visually obvious by its absence.
//
// Usage:
//   node scripts/release/sign-manifest.mjs --seckey ~/.loombre-release-signing.key dist/release/manifest.json dist/release/SHA256SUMS
//
// Passphrase: prompted interactively by minisign itself (this script never
// reads or stores it) unless MINISIGN_PASSWORD is set in the environment,
// in which case it's piped to minisign's stdin non-interactively (the
// same mechanism .github/workflows/release.yml's CI signing step uses
// with the LOOMBRE_MINISIGN_SECKEY_PASSWORD secret).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function commandExists(cmd) {
  const result = spawnSync(cmd, ["-v"], { stdio: "ignore" });
  return !result.error;
}

function parseArgs(argv) {
  const files = [];
  let seckey;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--seckey") {
      seckey = argv[i + 1];
      i += 1;
    } else {
      files.push(argv[i]);
    }
  }
  return { seckey, files };
}

function main() {
  const { seckey, files } = parseArgs(process.argv.slice(2));

  if (!commandExists("minisign")) {
    console.log(
      "sign-manifest: SKIPPED — the `minisign` binary is not installed on this machine.\n" +
        "  Install it (macOS: `brew install minisign`; Linux: your package manager; " +
        "Windows: scoop/choco, or WSL) and re-run, or sign these files on a machine " +
        "that has it. See keys/README.md.",
    );
    process.exit(0);
  }

  if (!seckey || !existsSync(seckey)) {
    console.error(`sign-manifest: --seckey ${JSON.stringify(seckey)} not found. See keys/README.md.`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("sign-manifest: no files given to sign. Usage: sign-manifest.mjs --seckey <path> <file...>");
    process.exit(1);
  }

  const password = process.env["MINISIGN_PASSWORD"];

  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`sign-manifest: ${file} does not exist`);
      process.exit(1);
    }
    // Standard Ed mode is minisign's default — deliberately NOT passing
    // -x anywhere in this arg list (P4.18).
    const args = ["-S", "-s", seckey, "-m", file];
    const result = spawnSync("minisign", args, {
      stdio: password ? ["pipe", "inherit", "inherit"] : "inherit",
      input: password ? `${password}\n` : undefined,
    });
    if (result.status !== 0) {
      console.error(`sign-manifest: minisign failed signing ${file} (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
    console.log(`sign-manifest: wrote ${file}.minisig`);
  }
}

main();
