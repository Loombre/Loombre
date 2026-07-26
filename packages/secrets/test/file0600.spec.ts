// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/file0600.spec.ts
//
// Platform-independent (no OS credential store involved) — runs on every CI
// runner. Covers generate-idempotency, store-overwrite, resolve-not-found,
// remove-is-best-effort, and the 0600 permission bit itself (skipped on
// win32, which has no POSIX mode bits — same convention as every other
// 0600-mode assertion in this repo, e.g. apps/server/src/tls/fs-secret.ts's
// own test).

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFile0600Backend } from "../src/file0600.js";
import { SecretNotFoundError } from "../src/errors.js";

describe("file0600 backend", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loombre-secrets-file0600-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generate() creates a fresh random value and is idempotent on re-call", async () => {
    const backend = createFile0600Backend();
    const key = join(dir, "sub", "secret.key");

    const first = await backend.generate(key);
    expect(first.ref).toEqual({ backend: "file0600", key });
    expect(first.value.length).toBeGreaterThan(20);

    const second = await backend.generate(key);
    expect(second.value).toBe(first.value);
  });

  it("generate() writes a 0600-mode file", async () => {
    if (process.platform === "win32") return; // no POSIX mode bits
    const backend = createFile0600Backend();
    const key = join(dir, "secret.key");
    await backend.generate(key);
    const mode = statSync(key).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("store() writes an explicit value, overwriting any existing one", async () => {
    const backend = createFile0600Backend();
    const key = join(dir, "secret.key");

    await backend.store(key, "first-value");
    expect(await backend.resolve({ backend: "file0600", key })).toBe("first-value");

    await backend.store(key, "second-value");
    expect(await backend.resolve({ backend: "file0600", key })).toBe("second-value");
  });

  it("resolve() throws SecretNotFoundError for a key that was never written", async () => {
    const backend = createFile0600Backend();
    const key = join(dir, "never-written.key");
    await expect(backend.resolve({ backend: "file0600", key })).rejects.toThrow(SecretNotFoundError);
  });

  it("remove() deletes the file; is a silent no-op on an already-missing one", async () => {
    const backend = createFile0600Backend();
    const key = join(dir, "secret.key");
    await backend.store(key, "value");

    await backend.remove({ backend: "file0600", key });
    await expect(backend.resolve({ backend: "file0600", key })).rejects.toThrow(SecretNotFoundError);

    await expect(backend.remove({ backend: "file0600", key })).resolves.toBeUndefined();
  });
});
