// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/vendor-layout.ts
//
// Pure path-layout logic ONLY — no fs access here (existence checks live in
// binaries.ts, the I/O half of this split). MUST stay in sync with
// scripts/fetch-embedded-pg.mjs's `vendorPlatformVersionDir`/
// `postgresBinaryName` (that script's header names this file as its
// cross-reference) — both independently implement the identical
// "<vendorDir>/<platform>/<version>/bin/<name>" contract because production
// src/ code in a workspace package must not import a top-level repo script.

import { join } from "node:path";
import type { EmbeddedPgPlatform } from "./platform.js";
import { isWindowsPlatform } from "./platform.js";

export interface VendorBinaryPaths {
  root: string;
  binDir: string;
  libDir: string;
  postgres: string;
  initdb: string;
  pgCtl: string;
  psql: string;
  pgIsready: string;
  pgControldata: string;
  pgDumpall: string;
}

function exeName(base: string, platform: EmbeddedPgPlatform): string {
  return isWindowsPlatform(platform) ? `${base}.exe` : base;
}

/** Pure: builds every path this package needs for a given vendored
 *  platform+version, WITHOUT checking any of them exist. */
export function resolveVendorBinaryPaths(vendorDir: string, platform: EmbeddedPgPlatform, version: string): VendorBinaryPaths {
  const root = join(vendorDir, platform, version);
  const binDir = join(root, "bin");
  const libDir = join(root, "lib");
  return {
    root,
    binDir,
    libDir,
    postgres: join(binDir, exeName("postgres", platform)),
    initdb: join(binDir, exeName("initdb", platform)),
    pgCtl: join(binDir, exeName("pg_ctl", platform)),
    psql: join(binDir, exeName("psql", platform)),
    pgIsready: join(binDir, exeName("pg_isready", platform)),
    pgControldata: join(binDir, exeName("pg_controldata", platform)),
    pgDumpall: join(binDir, exeName("pg_dumpall", platform)),
  };
}
