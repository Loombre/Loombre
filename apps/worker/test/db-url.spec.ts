// SPDX-License-Identifier: AGPL-3.0-only
// resolveWorkerDatabaseUrl is the worker's side of STATE.md P4.2's
// single-provisioner rule: the worker NEVER provisions; in an installed
// embedded-mode deployment (LOOMBRE_DATA_DIR set, DATABASE_URL unset) it
// polls for the credentials apps/server's provisioner writes, via
// @loombre/provisioning-pg's discovery seam. Explicit DATABASE_URL always
// wins; a bare dev checkout (neither var set) keeps the compose fallback.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { generateSecret, embeddedSuperuserSecretPath } from "@loombre/provisioning-pg";
import { DEV_FALLBACK_DATABASE_URL, resolveWorkerDatabaseUrl } from "../src/db-url.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "loombre-worker-dburl-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function writeEmbeddedSecret(): Promise<void> {
  const secretPath = embeddedSuperuserSecretPath(dataDir);
  mkdirSync(dirname(secretPath), { recursive: true });
  await generateSecret("file0600", secretPath);
}

describe("resolveWorkerDatabaseUrl", () => {
  it("an explicit DATABASE_URL wins unconditionally", async () => {
    await expect(
      resolveWorkerDatabaseUrl({ DATABASE_URL: "postgres://x:y@db.example:5432/loombre", LOOMBRE_DATA_DIR: dataDir }),
    ).resolves.toBe("postgres://x:y@db.example:5432/loombre");
  });

  it("bare dev checkout (neither var set) keeps the compose fallback", async () => {
    await expect(resolveWorkerDatabaseUrl({})).resolves.toBe(DEV_FALLBACK_DATABASE_URL);
  });

  it("embedded mode: discovers the provisioner's credentials", async () => {
    await writeEmbeddedSecret();
    const url = await resolveWorkerDatabaseUrl({ LOOMBRE_DATA_DIR: dataDir });
    expect(url).toMatch(/^postgres:\/\/loombre:.+@127\.0\.0\.1:\d+\/loombre$/);
  });

  it("embedded mode: polls until the secret appears", async () => {
    const pending = resolveWorkerDatabaseUrl(
      { LOOMBRE_DATA_DIR: dataDir },
      { timeoutMs: 5_000, intervalMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeEmbeddedSecret();
    await expect(pending).resolves.toMatch(/^postgres:\/\/loombre:/);
  });

  it("embedded mode: bounded wait, then fails with the single-provisioner explanation", async () => {
    await expect(
      resolveWorkerDatabaseUrl({ LOOMBRE_DATA_DIR: dataDir }, { timeoutMs: 300, intervalMs: 50 }),
    ).rejects.toThrow(/single-provisioner|apps\/server|provision/i);
  });

  it("embedded mode: honors LOOMBRE_EMBEDDED_PG_PORT", async () => {
    await writeEmbeddedSecret();
    const url = await resolveWorkerDatabaseUrl({ LOOMBRE_DATA_DIR: dataDir, LOOMBRE_EMBEDDED_PG_PORT: "55999" });
    expect(url).toContain("@127.0.0.1:55999/");
  });
});
