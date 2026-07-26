// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/test/vendor-layout.spec.ts
//
// SEPARATOR CONTRACT (settled by the first windows-latest CI run, which
// failed here): resolveVendorBinaryPaths builds HOST-NATIVE paths via
// node:path join — they are handed straight to existsSync() and to spawn,
// and production ALWAYS passes the host's own platform (apps/server/src/
// bootstrap/provisioning.ts:106 derives it from process.platform/arch).
// So backslashes on Windows are CORRECT, and the layout is only ever
// resolved for the running host. The `platform` argument stays target-
// shaped because it also selects the .exe suffix and the directory name —
// NOT because a foreign target's paths are ever resolved for real.
//
// Segment structure is therefore asserted with join()-built expectations
// (host-agnostic); the .exe suffix — which IS genuinely target-derived —
// keeps its own literal assertions below.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveVendorBinaryPaths } from "../src/vendor-layout.js";

describe("resolveVendorBinaryPaths", () => {
  it("lays out <vendorDir>/<platform>/<version>/bin|lib/<binary> in host-native separators", () => {
    const root = join("/vendor", "macos-arm64", "18.4.0");
    const paths = resolveVendorBinaryPaths("/vendor", "macos-arm64", "18.4.0");
    expect(paths.root).toBe(root);
    expect(paths.binDir).toBe(join(root, "bin"));
    expect(paths.libDir).toBe(join(root, "lib"));
    expect(paths.postgres).toBe(join(root, "bin", "postgres"));
    expect(paths.initdb).toBe(join(root, "bin", "initdb"));
    expect(paths.pgCtl).toBe(join(root, "bin", "pg_ctl"));
    expect(paths.psql).toBe(join(root, "bin", "psql"));
    expect(paths.pgIsready).toBe(join(root, "bin", "pg_isready"));
    expect(paths.pgControldata).toBe(join(root, "bin", "pg_controldata"));
    expect(paths.pgDumpall).toBe(join(root, "bin", "pg_dumpall"));
  });

  it("appends .exe for windows-x64", () => {
    const paths = resolveVendorBinaryPaths("/vendor", "windows-x64", "18.4.0");
    expect(paths.postgres.endsWith("postgres.exe")).toBe(true);
    expect(paths.initdb.endsWith("initdb.exe")).toBe(true);
    expect(paths.psql.endsWith("psql.exe")).toBe(true);
  });

  it("does not append .exe for linux/macos", () => {
    for (const platform of ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"] as const) {
      const paths = resolveVendorBinaryPaths("/vendor", platform, "18.4.0");
      expect(paths.postgres.endsWith(".exe")).toBe(false);
    }
  });

  it("keys the path by both platform and version — different versions never collide", () => {
    const a = resolveVendorBinaryPaths("/vendor", "linux-x64", "18.4.0");
    const b = resolveVendorBinaryPaths("/vendor", "linux-x64", "17.10.0");
    expect(a.root).not.toBe(b.root);
  });
});
