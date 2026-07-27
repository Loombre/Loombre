// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-storage-pool.spec.ts
//
// Unit tests for computeStoragePool (STATE.md Phosphor retheme, W1c
// "contract enablers" lane — sidebar POOL meter, GET /system/info's
// additive storagePool field). Real filesystem, no DB: fs.stat/fs.statfs
// against real temp directories on this host, which is exactly what the
// function does in production against real library root paths.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStoragePool } from "./admin-storage-pool.js";

const dirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("computeStoragePool", () => {
  it("returns sane totals for a real, existing path", async () => {
    const dir = makeTmpDir("loombre-pool-sane-");
    const result = await computeStoragePool([dir]);
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBeGreaterThan(0);
    expect(result!.usedBytes).toBeGreaterThanOrEqual(0);
    expect(result!.usedBytes).toBeLessThanOrEqual(result!.totalBytes);
  });

  it("dedupes two library paths on the SAME filesystem — counted once, not twice", async () => {
    const dirA = makeTmpDir("loombre-pool-dedupe-a-");
    const dirB = makeTmpDir("loombre-pool-dedupe-b-");

    const single = await computeStoragePool([dirA]);
    const doubled = await computeStoragePool([dirA, dirB]);

    expect(single).not.toBeNull();
    expect(doubled).not.toBeNull();
    // Deliberately NOT toEqual(single): that byte-compared two LIVE statfs
    // snapshots, and a busy disk's usedBytes moves between the calls — the
    // documented local flake (STATE.md "LOCAL FLAKE, pre-existing"; it
    // failed two consecutive audit-residue exit gates before this fix).
    // The dedupe property is structural: summing the same filesystem twice
    // would DOUBLE both figures. totalBytes is immutable across calls, so
    // strict equality there is the crisp proof; usedBytes gets a drift
    // tolerance (1% or 128 MiB, whichever is larger) that still catches
    // double-counting, which is a ~100% error.
    expect(doubled!.totalBytes).toBe(single!.totalBytes);
    const usedDrift = Math.abs(doubled!.usedBytes - single!.usedBytes);
    const tolerance = Math.max(single!.usedBytes * 0.01, 128 * 1024 * 1024);
    expect(usedDrift).toBeLessThan(tolerance);
  });

  it("skips an unreadable/missing path without failing the whole aggregate", async () => {
    const dir = makeTmpDir("loombre-pool-partial-");
    const result = await computeStoragePool([dir, "/definitely/does/not/exist/loombre-w1c"]);
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBeGreaterThan(0);
  });

  it("returns null when every path is missing/unreadable", async () => {
    const result = await computeStoragePool([
      "/definitely/does/not/exist/loombre-w1c-a",
      "/definitely/does/not/exist/loombre-w1c-b",
    ]);
    expect(result).toBeNull();
  });

  it("returns null for an empty path list", async () => {
    expect(await computeStoragePool([])).toBeNull();
  });
});
