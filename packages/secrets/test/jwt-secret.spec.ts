// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/jwt-secret.spec.ts
//
// Platform-independent core (forces backend="file0600" via LOOMBRE_SECRET_BACKEND
// so these run identically on every CI runner — no OS credential store
// involved) plus one darwin-gated REAL test proving the file->keychain
// migration path P4.17's "first boot" scenario actually needs. Each test
// uses its own tmpdir-scoped `key` — no shared well-known constant, no
// cross-test/cross-suite collisions.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveJwtSecret } from "../src/jwt-secret.js";
import { createFile0600Backend } from "../src/file0600.js";
import { createNativeKeyringBackend } from "../src/native-keyring.js";

describe("resolveJwtSecret", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-secrets-jwt-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("env always wins, even when a store-backed secret already exists at the same key", async () => {
    const key = join(dataDir, "jwt.secret");
    const backend = createFile0600Backend();
    await backend.generate(key);

    const result = await resolveJwtSecret({
      key,
      env: { LOOMBRE_JWT_SECRET: "explicit-operator-secret", LOOMBRE_SECRET_BACKEND: "file0600" },
    });
    expect(result).toEqual({ secret: "explicit-operator-secret", source: "env" });
  });

  it("generates and persists on first call (no env, no existing secret) — file0600 backend", async () => {
    const key = join(dataDir, "jwt.secret");
    const first = await resolveJwtSecret({ key, env: { LOOMBRE_SECRET_BACKEND: "file0600" }, platform: "linux" });
    expect(first.source).toBe("generated");
    expect(first.secret.length).toBeGreaterThan(20);
    expect(first.backend).toBe("file0600");
  });

  it("second boot (same backend, no env) resolves the SAME persisted secret — kills the P4.17 ephemeral-fallback footgun", async () => {
    const key = join(dataDir, "jwt.secret");
    const env = { LOOMBRE_SECRET_BACKEND: "file0600" as const };

    const first = await resolveJwtSecret({ key, env, platform: "linux" });
    expect(first.source).toBe("generated");

    const second = await resolveJwtSecret({ key, env, platform: "linux" });
    expect(second.source).toBe("existing");
    expect(second.secret).toBe(first.secret);
  });

  const isDarwin = process.platform === "darwin";
  if (!isDarwin) {
    console.warn(
      "[loombre] packages/secrets: skipping REAL first-boot file->keychain JWT-secret migration test — " +
        `this host is "${process.platform}", not darwin.`,
    );
  }

  it.skipIf(!isDarwin)("REAL: an existing file0600 JWT secret migrates to the Keychain once it becomes the detected backend, keeping the SAME value", async () => {
    const key = join(dataDir, "jwt.secret");
    const fileBackend = createFile0600Backend();
    const keychainBackend = createNativeKeyringBackend("keychain");

    // Simulate "this install's first boots ran before/without a native
    // store" by seeding the well-known key directly under file0600.
    const preExisting = await fileBackend.generate(key);

    try {
      const result = await resolveJwtSecret({ key, env: {}, platform: "darwin" });
      expect(result.backend).toBe("keychain");
      expect(result.source).toBe("migrated");
      expect(result.secret).toBe(preExisting.value);

      // The file copy is gone (migrateSecret's default removeSource: true).
      await expect(fileBackend.resolve({ backend: "file0600", key })).rejects.toThrow();

      // A subsequent boot resolves the SAME value straight from the Keychain.
      const again = await resolveJwtSecret({ key, env: {}, platform: "darwin" });
      expect(again).toEqual({ secret: preExisting.value, source: "existing", backend: "keychain" });
    } finally {
      await keychainBackend.remove({ backend: "keychain", key }).catch(() => undefined);
      await fileBackend.remove({ backend: "file0600", key }).catch(() => undefined);
    }
  });

  it.skipIf(!isDarwin)("REAL: forcing LOOMBRE_SECRET_BACKEND=file0600 AFTER an auto-migration to the Keychain migrates back, keeping the SAME value (never a silent new secret)", async () => {
    const key = join(dataDir, "jwt.secret");
    const fileBackend = createFile0600Backend();
    const keychainBackend = createNativeKeyringBackend("keychain");

    const preExisting = await fileBackend.generate(key);

    try {
      // Boot 1: auto-detect moves the value into the Keychain and (per
      // migrateSecret's removeSource default) deletes the file copy.
      const migratedUp = await resolveJwtSecret({ key, env: {}, platform: "darwin" });
      expect(migratedUp.backend).toBe("keychain");
      expect(migratedUp.secret).toBe(preExisting.value);

      // Boot 2: the operator forces file0600 back. file0600 holds nothing at
      // this key any more, so without the reverse lookback this boot mints a
      // brand-new secret and logs every session out.
      const forced = { LOOMBRE_SECRET_BACKEND: "file0600" as const };
      const downgraded = await resolveJwtSecret({ key, env: forced, platform: "darwin" });
      expect(downgraded).toEqual({ secret: preExisting.value, source: "migrated", backend: "file0600" });

      // Boot 3: still the same value, now straight out of the file.
      const again = await resolveJwtSecret({ key, env: forced, platform: "darwin" });
      expect(again).toEqual({ secret: preExisting.value, source: "existing", backend: "file0600" });
    } finally {
      await keychainBackend.remove({ backend: "keychain", key }).catch(() => undefined);
      await fileBackend.remove({ backend: "file0600", key }).catch(() => undefined);
    }
  });
});
