// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/binaries.ts
//
// I/O half of the vendor-layout split: turns the pure paths from
// vendor-layout.ts into a verified VendorBinaries handle, or throws
// BinaryMissingError pointing at scripts/fetch-embedded-pg.mjs.

import { existsSync } from "node:fs";
import { resolveVendorBinaryPaths, type VendorBinaryPaths } from "./vendor-layout.js";
import type { EmbeddedPgPlatform } from "./platform.js";
import { BinaryMissingError } from "./errors.js";

export type VendorBinaries = VendorBinaryPaths;

const CHECKED_KEYS = ["postgres", "initdb", "pgCtl", "psql", "pgIsready", "pgControldata", "pgDumpall"] as const;

/** Resolves + verifies every binary this package needs exists on disk.
 *  Throws BinaryMissingError (naming the FIRST missing one) rather than
 *  failing later with a bare spawn ENOENT deep inside provision()/start(). */
export function resolveVendorBinaries(vendorDir: string, platform: EmbeddedPgPlatform, version: string): VendorBinaries {
  const paths = resolveVendorBinaryPaths(vendorDir, platform, version);
  for (const key of CHECKED_KEYS) {
    const path = paths[key];
    if (!existsSync(path)) {
      throw new BinaryMissingError(key, path);
    }
  }
  return paths;
}
