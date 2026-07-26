// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { resolveVendorBinaryPaths } from "../src/vendor-layout.js";

describe("resolveVendorBinaryPaths", () => {
  it("builds POSIX-style binary names for macos-arm64", () => {
    const paths = resolveVendorBinaryPaths("/vendor", "macos-arm64", "18.4.0");
    expect(paths.root).toBe("/vendor/macos-arm64/18.4.0");
    expect(paths.binDir).toBe("/vendor/macos-arm64/18.4.0/bin");
    expect(paths.libDir).toBe("/vendor/macos-arm64/18.4.0/lib");
    expect(paths.postgres).toBe("/vendor/macos-arm64/18.4.0/bin/postgres");
    expect(paths.initdb).toBe("/vendor/macos-arm64/18.4.0/bin/initdb");
    expect(paths.pgCtl).toBe("/vendor/macos-arm64/18.4.0/bin/pg_ctl");
    expect(paths.psql).toBe("/vendor/macos-arm64/18.4.0/bin/psql");
    expect(paths.pgIsready).toBe("/vendor/macos-arm64/18.4.0/bin/pg_isready");
    expect(paths.pgControldata).toBe("/vendor/macos-arm64/18.4.0/bin/pg_controldata");
    expect(paths.pgDumpall).toBe("/vendor/macos-arm64/18.4.0/bin/pg_dumpall");
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
