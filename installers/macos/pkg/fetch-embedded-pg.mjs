#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/fetch-embedded-pg.mjs
//
// scripts/fetch-embedded-pg.mjs (lane B) HAS LANDED — this wraps the real
// `fetchEmbeddedPg({ platform, pgVersion, manifestPath, vendorDir, force })`
// it exports directly (unlike fetch-ffmpeg.mjs, this one has a real
// programmatic entry point — see that script's own header: it's used by
// packages/provisioning-pg's own integration tests the same way).
//
// SCOPE NOTE (installers/macos/LAYOUT.md §8 — see its "SUPERSEDED" note):
// this stages the vendored PostgreSQL binaries into the payload (proving
// the fetch + packages/provisioning-pg's vendor-layout contract resolve
// correctly end to end), landing them at runtime/pg/<platform>/<version> —
// the same vendor-layout shape bin/loombre-server reads back. Embedded-PG
// service wiring HAS LANDED: with DATABASE_URL unset, bin/loombre-server
// points LOOMBRE_EMBEDDED_PG_VENDOR_DIR at this staged tree and
// apps/server/src/bootstrap/provisioning.ts provisions and supervises the
// bundled PostgreSQL as the default install path. External PG (D1) is now
// the opt-in override, set via DATABASE_URL in config/loombre.env.

import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const REAL_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "fetch-embedded-pg.mjs");

/** fetchEmbeddedPg({ platform, arch, destDir }) -> { staged, placeholder, ... } */
export async function fetchEmbeddedPg({ platform, arch, destDir }) {
  if (!existsSync(REAL_SCRIPT_PATH)) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      path.join(destDir, "PLACEHOLDER.txt"),
      `EMBEDDED POSTGRESQL NOT BUNDLED — scripts/fetch-embedded-pg.mjs (lane B) is absent. ` +
        `Server/worker LaunchDaemons in this build use the external-PG path (D1). See ` +
        `installers/macos/LAYOUT.md §8.\n`,
      "utf8",
    );
    return { staged: false, placeholder: true, platform, arch };
  }

  const manifestPlatform = `macos-${arch}`;
  const vendorDir = path.join(REPO_ROOT, "vendor", "embedded-pg");

  const mod = await import(REAL_SCRIPT_PATH);
  const vendoredDir = await mod.fetchEmbeddedPg({ platform: manifestPlatform, vendorDir });
  console.log(`[fetch-embedded-pg] vendored to ${vendoredDir}`);

  mkdirSync(destDir, { recursive: true });
  cpSync(vendoredDir, destDir, { recursive: true });

  const provenancePath = path.join(destDir, "PROVENANCE.json");
  const provenance = existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, "utf8")) : null;

  console.log(
    `[fetch-embedded-pg] staged real vendored PostgreSQL ${provenance?.version ?? "(unknown version)"} ` +
      `into the payload (embedded-PG service wiring is live — see this file's SCOPE NOTE + LAYOUT.md §8)`,
  );

  return { staged: true, placeholder: false, platform, arch, version: provenance?.version };
}
