// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugin-keyring.spec.ts
//
// LD1/LD9 keyring roundtrip against the file0600 backend (deterministic,
// side-effect-free — same established convention as
// apps/server/src/settings/provider-keys.service.spec.ts: writes under a
// throwaway LOOMBRE_DATA_DIR instead of touching a real OS credential
// store). No DB needed — this module only touches packages/secrets +
// the filesystem.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mintPluginHmac,
  pluginConfigSecretLogicalName,
  pluginHmacLogicalName,
  pluginSecretStorePath,
  removeAllPluginSecrets,
  removePluginConfigSecret,
  removePluginHmac,
  resolveAllPluginConfigSecrets,
  resolvePluginConfigSecret,
  rotatePluginHmac,
  storePluginConfigSecret,
} from "./plugin-keyring.js";

let dataDir: string;
const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(() => {
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-plugin-keyring-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

/** Every file0600-backed secret this test suite writes anywhere under
 *  `dataDir`, concatenated — used for LD9 "distinctive value" absence/
 *  presence proofs below. */
function readAllSecretFilesConcatenated(): string {
  const secretsDir = path.join(dataDir, "secrets");
  if (!existsSync(secretsDir)) return "";
  return readdirSync(secretsDir)
    .map((f) => readFileSync(path.join(secretsDir, f), "utf8"))
    .join("\n");
}

describe("HMAC mint/rotate/remove (LD1)", () => {
  it("mints a fresh, non-empty secret", async () => {
    const secret = await mintPluginHmac("plugin-a");
    expect(secret.length).toBeGreaterThan(20);
  });

  it("mints DIFFERENT secrets for different plugin ids", async () => {
    const a = await mintPluginHmac("plugin-distinct-1");
    const b = await mintPluginHmac("plugin-distinct-2");
    expect(a).not.toBe(b);
  });

  it("rotatePluginHmac produces a genuinely fresh value, distinct from the prior mint", async () => {
    const first = await mintPluginHmac("plugin-rotate-test");
    const second = await rotatePluginHmac("plugin-rotate-test");
    expect(second).not.toBe(first);
  });

  it("removePluginHmac deletes the underlying keyring entry", async () => {
    const pluginId = "plugin-remove-hmac-test";
    await mintPluginHmac(pluginId);
    const filePath = pluginSecretStorePath(pluginHmacLogicalName(pluginId));
    expect(existsSync(filePath)).toBe(true);
    await removePluginHmac(pluginId);
    expect(existsSync(filePath)).toBe(false);
  });

  it("removing an HMAC that was never minted is a silent no-op (packages/secrets removeSecret never throws)", async () => {
    await expect(removePluginHmac("plugin-never-existed")).resolves.toBeUndefined();
  });
});

describe("per-field config secrets (LD1)", () => {
  it("store -> resolve round-trips the plaintext value exactly", async () => {
    await storePluginConfigSecret("plugin-cfg-1", "webhookUrl", "https://hooks.example/roundtrip");
    const resolved = await resolvePluginConfigSecret("plugin-cfg-1", "webhookUrl");
    expect(resolved).toBe("https://hooks.example/roundtrip");
  });

  it("resolving a field that was never stored returns null, not an error", async () => {
    const resolved = await resolvePluginConfigSecret("plugin-cfg-1", "neverStored");
    expect(resolved).toBeNull();
  });

  it("removePluginConfigSecret makes a subsequent resolve return null", async () => {
    await storePluginConfigSecret("plugin-cfg-2", "apiKey", "s3cr3t-value");
    await removePluginConfigSecret("plugin-cfg-2", "apiKey");
    expect(await resolvePluginConfigSecret("plugin-cfg-2", "apiKey")).toBeNull();
  });

  it("resolveAllPluginConfigSecrets returns only the fields actually stored", async () => {
    await storePluginConfigSecret("plugin-cfg-3", "fieldA", "value-a");
    // fieldB deliberately never stored.
    const all = await resolveAllPluginConfigSecrets("plugin-cfg-3", ["fieldA", "fieldB"]);
    expect(all).toEqual({ fieldA: "value-a" });
  });

  it("two different plugins' same-named field never collide", async () => {
    await storePluginConfigSecret("plugin-cfg-collide-1", "sharedName", "value-one");
    await storePluginConfigSecret("plugin-cfg-collide-2", "sharedName", "value-two");
    expect(await resolvePluginConfigSecret("plugin-cfg-collide-1", "sharedName")).toBe("value-one");
    expect(await resolvePluginConfigSecret("plugin-cfg-collide-2", "sharedName")).toBe("value-two");
  });
});

describe("removeAllPluginSecrets (LD9: nothing keyring-side survives a plugin's removal)", () => {
  it("removes the HMAC and every named secret field's file", async () => {
    const pluginId = "plugin-remove-all-test";
    await mintPluginHmac(pluginId);
    await storePluginConfigSecret(pluginId, "webhookUrl", "https://hooks.example/removeall");
    await storePluginConfigSecret(pluginId, "apiKey", "DISTINCTIVE-REMOVE-ALL-VALUE");

    const hmacPath = pluginSecretStorePath(pluginHmacLogicalName(pluginId));
    const webhookPath = pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, "webhookUrl"));
    const apiKeyPath = pluginSecretStorePath(pluginConfigSecretLogicalName(pluginId, "apiKey"));
    expect(existsSync(hmacPath)).toBe(true);
    expect(existsSync(webhookPath)).toBe(true);
    expect(existsSync(apiKeyPath)).toBe(true);

    await removeAllPluginSecrets(pluginId, ["webhookUrl", "apiKey"]);

    expect(existsSync(hmacPath)).toBe(false);
    expect(existsSync(webhookPath)).toBe(false);
    expect(existsSync(apiKeyPath)).toBe(false);
    expect(readAllSecretFilesConcatenated()).not.toContain("DISTINCTIVE-REMOVE-ALL-VALUE");
  });
});

describe("naming (LD1 exact keyring naming)", () => {
  it("pluginHmacLogicalName matches 'plugin-hmac-<pluginId>' exactly", () => {
    expect(pluginHmacLogicalName("abc-123")).toBe("plugin-hmac-abc-123");
  });

  it("pluginConfigSecretLogicalName matches 'plugin-<pluginId>-<fieldName>' exactly", () => {
    expect(pluginConfigSecretLogicalName("abc-123", "webhookUrl")).toBe("plugin-abc-123-webhookUrl");
  });
});
