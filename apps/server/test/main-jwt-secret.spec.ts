// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/main-jwt-secret.spec.ts
//
// Unit coverage for resolveAndSeedJwtSecret (P4.17/lane G1): the thin
// integration seam between main.ts's boot sequence and @loombre/secrets's
// resolveJwtSecret — no live server/DB needed, this is a pure
// process.env-in/process.env-out contract. @loombre/secrets's own test
// suite (packages/secrets/test/jwt-secret.spec.ts) covers the actual
// resolution logic (env/migrate/existing/generated) in depth; this file
// only proves main.ts WIRES it correctly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAndSeedJwtSecret } from "../src/main.js";

describe("resolveAndSeedJwtSecret", () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let originalSecret: string | undefined;
  let originalBackend: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-main-jwt-"));
    originalDataDir = process.env["LOOMBRE_DATA_DIR"];
    originalSecret = process.env["LOOMBRE_JWT_SECRET"];
    originalBackend = process.env["LOOMBRE_SECRET_BACKEND"];
    process.env["LOOMBRE_DATA_DIR"] = dataDir;
    process.env["LOOMBRE_SECRET_BACKEND"] = "file0600"; // deterministic, no OS keychain probing
    delete process.env["LOOMBRE_JWT_SECRET"];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env["LOOMBRE_DATA_DIR"];
    else process.env["LOOMBRE_DATA_DIR"] = originalDataDir;
    if (originalSecret === undefined) delete process.env["LOOMBRE_JWT_SECRET"];
    else process.env["LOOMBRE_JWT_SECRET"] = originalSecret;
    if (originalBackend === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
    else process.env["LOOMBRE_SECRET_BACKEND"] = originalBackend;
  });

  it("leaves an explicitly-set LOOMBRE_JWT_SECRET completely untouched (env always wins)", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "operator-set-value";
    await resolveAndSeedJwtSecret(process.env);
    expect(process.env["LOOMBRE_JWT_SECRET"]).toBe("operator-set-value");
  });

  it("seeds process.env.LOOMBRE_JWT_SECRET on first boot (none set, nothing persisted yet)", async () => {
    expect(process.env["LOOMBRE_JWT_SECRET"]).toBeUndefined();
    await resolveAndSeedJwtSecret(process.env);
    expect(process.env["LOOMBRE_JWT_SECRET"]).toBeDefined();
    expect(process.env["LOOMBRE_JWT_SECRET"]!.length).toBeGreaterThan(20);
  });

  it("second boot (same dataDir, still no env) resolves the SAME persisted value — kills the ephemeral-fallback footgun end to end", async () => {
    await resolveAndSeedJwtSecret(process.env);
    const first = process.env["LOOMBRE_JWT_SECRET"];

    delete process.env["LOOMBRE_JWT_SECRET"]; // simulate a fresh process that never set it
    await resolveAndSeedJwtSecret(process.env);
    expect(process.env["LOOMBRE_JWT_SECRET"]).toBe(first);
  });

  it("never throws even if the secrets store is unusable (falls back silently, logs a warning)", async () => {
    process.env["LOOMBRE_SECRET_BACKEND"] = "not-a-real-backend";
    await expect(resolveAndSeedJwtSecret(process.env)).resolves.toBeUndefined();
    // Falls through without seeding — token.service.ts's own ephemeral
    // fallback takes over, exactly as it did before this function existed.
    expect(process.env["LOOMBRE_JWT_SECRET"]).toBeUndefined();
  });
});
