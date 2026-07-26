// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/keyring.spec.ts
//
// Mirrors apps/worker/test/metadata/keyring-keys.spec.ts's convention
// (file0600 backend under a throwaway LOOMBRE_DATA_DIR — no real OS
// credential store touched): proves resolvePluginHmacSecret finds a
// secret written at the EXACT path apps/server/src/plugins/
// plugin-keyring.ts's mintPluginHmac would write it to (LD9:
// `plugin-hmac-<pluginId>`, RAW plaintext, no JSON envelope) — the
// tripwire that catches this lane's derivation ever drifting from the
// server-side writer's.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSecretBackend, storeSecret } from "@loombre/secrets";
import { pluginHmacKeyPath, resolvePluginHmacSecret } from "../../src/plugin-delivery/keyring.js";

let dataDir: string;
const ORIGINAL_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const PLUGIN_ID = "0199a000-0000-7000-8000-00000000abcd";

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, LOOMBRE_DATA_DIR: dataDir, ...overrides };
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-plugin-hmac-keyring-test-"));
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_BACKEND;
});

describe("pluginHmacKeyPath", () => {
  it("matches LD9's `plugin-hmac-<pluginId>` naming under <dataDir>/secrets/", () => {
    expect(pluginHmacKeyPath(PLUGIN_ID, envFor())).toBe(`${dataDir}/secrets/plugin-hmac-${PLUGIN_ID}`);
  });
});

describe("resolvePluginHmacSecret", () => {
  it("resolves a RAW plaintext secret written EXACTLY as apps/server/src/plugins/plugin-keyring.ts's mintPluginHmac does", async () => {
    const detected = await detectSecretBackend();
    await storeSecret(detected.backend, pluginHmacKeyPath(PLUGIN_ID, envFor()), "delivery-signing-secret-value");
    const resolved = await resolvePluginHmacSecret(PLUGIN_ID, envFor());
    expect(resolved).toBe("delivery-signing-secret-value");
  });

  it("returns null when nothing has been stored — never throws", async () => {
    const missingId = "0199a000-0000-7000-8000-00000000miss";
    const resolved = await resolvePluginHmacSecret(missingId, envFor());
    expect(resolved).toBeNull();
  });

  it("returns null (never throws) for an empty-string secret", async () => {
    const emptyId = "0199a000-0000-7000-8000-00000000empt";
    const secretsDir = path.join(dataDir, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(path.join(secretsDir, `plugin-hmac-${emptyId}`), "", { mode: 0o600 });
    const resolved = await resolvePluginHmacSecret(emptyId, envFor());
    expect(resolved).toBeNull();
  });

  it("a genuine generateLppSigningSecret() value round-trips (proves compatibility with the real minting path)", async () => {
    const { generateLppSigningSecret } = await import("@loombre/plugin-protocol");
    const secret = generateLppSigningSecret();
    const id = "0199a000-0000-7000-8000-00000000real";
    const detected = await detectSecretBackend();
    await storeSecret(detected.backend, pluginHmacKeyPath(id, envFor()), secret);
    expect(await resolvePluginHmacSecret(id, envFor())).toBe(secret);
  });
});
