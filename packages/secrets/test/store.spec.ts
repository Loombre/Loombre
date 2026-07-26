// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/store.spec.ts
//
// The public façade (generateSecret/storeSecret/resolveSecret/removeSecret/
// tryResolveSecret) dispatches to the right backend via backends.ts — this
// suite only proves the DISPATCH + tryResolveSecret's null-collapsing
// behavior; backend-specific behavior is covered by file0600.spec.ts /
// native-keyring.spec.ts directly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecret, removeSecret, resolveSecret, storeSecret, tryResolveSecret } from "../src/store.js";

describe("store façade (file0600 dispatch)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loombre-secrets-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generateSecret/resolveSecret/removeSecret round-trip through backendFor", async () => {
    const key = join(dir, "secret.key");
    const generated = await generateSecret("file0600", key);
    expect(await resolveSecret(generated.ref)).toBe(generated.value);

    await removeSecret(generated.ref);
    await expect(resolveSecret(generated.ref)).rejects.toThrow();
  });

  it("storeSecret writes an explicit value", async () => {
    const key = join(dir, "secret.key");
    const ref = await storeSecret("file0600", key, "explicit-value");
    expect(await resolveSecret(ref)).toBe("explicit-value");
  });

  it("tryResolveSecret returns null for absence instead of throwing", async () => {
    const key = join(dir, "never-written.key");
    await expect(tryResolveSecret({ backend: "file0600", key })).resolves.toBeNull();
  });

  it("tryResolveSecret returns the value when present", async () => {
    const key = join(dir, "secret.key");
    await storeSecret("file0600", key, "value");
    await expect(tryResolveSecret({ backend: "file0600", key })).resolves.toBe("value");
  });
});
