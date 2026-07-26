// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/migrate.spec.ts
//
// migrateSecret() with file0600 as the SOURCE backend throughout (task
// spec: "MIGRATION between backends ... tested with the file backend as
// source"). The no-op (same-backend) case and the read-back-mismatch
// failure path run everywhere; the REAL file->keychain migration against
// this host's actual macOS Keychain is darwin-gated, same posture as
// native-keyring.spec.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFile0600Backend } from "../src/file0600.js";
import { migrateSecret } from "../src/migrate.js";
import { createNativeKeyringBackend } from "../src/native-keyring.js";

describe("migrateSecret", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loombre-secrets-migrate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when fromRef.backend already equals toBackend", async () => {
    const ref = { backend: "file0600" as const, key: join(dir, "secret.key") };
    const result = await migrateSecret(ref, "file0600");
    expect(result).toEqual({ ref, migrated: false });
  });

  const isDarwin = process.platform === "darwin";
  if (!isDarwin) {
    console.warn(
      "[loombre] packages/secrets: skipping REAL file->keychain migration test — " +
        `this host is "${process.platform}", not darwin.`,
    );
  }

  it.skipIf(!isDarwin)("REAL: migrates a file0600 secret to the real macOS Keychain, verified by read-back, then deletes the source file", async () => {
    const fileBackend = createFile0600Backend();
    const keychainBackend = createNativeKeyringBackend("keychain");

    const key = join(dir, "pg-superuser.secret");
    const generated = await fileBackend.generate(key);

    try {
      const result = await migrateSecret({ backend: "file0600", key }, "keychain");

      expect(result.migrated).toBe(true);
      expect(result.ref).toEqual({ backend: "keychain", key });

      // Value survived the trip unchanged (never regenerated).
      expect(await keychainBackend.resolve(result.ref)).toBe(generated.value);

      // Source file is gone (removeSource defaults to true).
      await expect(fileBackend.resolve({ backend: "file0600", key })).rejects.toThrow();
    } finally {
      await keychainBackend.remove({ backend: "keychain", key });
    }
  });

  it.skipIf(!isDarwin)("REAL: removeSource: false leaves the file0600 source copy intact", async () => {
    const fileBackend = createFile0600Backend();
    const keychainBackend = createNativeKeyringBackend("keychain");

    const key = join(dir, "keep-source.secret");
    const generated = await fileBackend.generate(key);

    try {
      const result = await migrateSecret({ backend: "file0600", key }, "keychain", { removeSource: false });
      expect(result.migrated).toBe(true);
      expect(await fileBackend.resolve({ backend: "file0600", key })).toBe(generated.value);
    } finally {
      await keychainBackend.remove({ backend: "keychain", key });
    }
  });
});
