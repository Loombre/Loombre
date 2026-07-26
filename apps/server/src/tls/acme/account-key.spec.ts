// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/account-key.spec.ts
//
// Real key generation (acme-client's own crypto.createPrivateEcdsaKey —
// not mocked), real 0600 file permission assertion, real idempotency
// (second call returns the SAME key, doesn't regenerate).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAccountKey } from "./account-key.js";
import { acmeAccountKeyPath } from "../storage.js";
import { assertOwnerOnlyFile } from "../test-support/assert-owner-only.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "loombre-acme-account-key-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ensureAccountKey", () => {
  it("generates a fresh PEM-encoded EC private key on first call", async () => {
    const result = await ensureAccountKey(dataDir);
    expect(result.created).toBe(true);
    expect(result.pem).toContain("BEGIN PRIVATE KEY");
    expect(result.pem).toContain("END PRIVATE KEY");
  });

  it("returns a SecretRef with backend=file0600 pointing at the exact storage path", async () => {
    const result = await ensureAccountKey(dataDir);
    expect(result.secretRef).toEqual({ backend: "file0600", key: acmeAccountKeyPath(dataDir) });
  });

  it("persists the key file owner-only (0600 on POSIX; owner-only DACL on Windows)", async () => {
    await ensureAccountKey(dataDir);
    assertOwnerOnlyFile(acmeAccountKeyPath(dataDir));
  });

  it("is idempotent: a second call loads the SAME key instead of generating a new one", async () => {
    const first = await ensureAccountKey(dataDir);
    const second = await ensureAccountKey(dataDir);
    expect(second.created).toBe(false);
    expect(second.pem).toBe(first.pem);
  });

  it("the on-disk file matches the returned pem exactly", async () => {
    const result = await ensureAccountKey(dataDir);
    expect(readFileSync(acmeAccountKeyPath(dataDir), "utf8")).toBe(result.pem);
  });
});
