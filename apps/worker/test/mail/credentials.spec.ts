// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/mail/credentials.spec.ts
//
// Optional mail transport run (M8/M10): proves the WORKER-side
// resolveMailCredentials picks up a credential pair written exactly the
// way the SERVER's MailCredentialsService writes it (same backend
// detection, same `<dataDir>/secrets/mail-smtp-credentials` identifier,
// same double-nested {value: JSON.stringify({username,password}), setAtMs}
// envelope), and that env precedence + graceful degradation both hold.
// Mirrors apps/worker/test/metadata/keyring-keys.spec.ts's own convention
// exactly (file0600 backend, throwaway LOOMBRE_DATA_DIR — never touches a
// real OS credential store).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSecretBackend, storeSecret } from "@loombre/secrets";
import { resolveMailCredentials } from "../../src/mail/credentials.js";

const USERNAME = "smtp-worker-test-user";
const PASSWORD = "smtp-worker-test-pw-8b1f";

let dataDir: string;
const ORIGINAL_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOOMBRE_DATA_DIR: dataDir,
    LOOMBRE_SMTP_USERNAME: undefined,
    LOOMBRE_SMTP_PASSWORD: undefined,
    ...overrides,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-mail-credentials-worker-test-"));
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";

  // Write the envelope EXACTLY as apps/server/src/settings/
  // mail-credentials.service.ts does: storeSecret at
  // `<dataDir>/secrets/mail-smtp-credentials` with the double-nested
  // envelope (outer {value, setAtMs}, inner value = JSON string of
  // {username, password}).
  const detected = await detectSecretBackend();
  await storeSecret(
    detected.backend,
    `${dataDir}/secrets/mail-smtp-credentials`,
    JSON.stringify({ value: JSON.stringify({ username: USERNAME, password: PASSWORD }), setAtMs: 1_784_900_000_000 }),
  );
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_BACKEND;
});

describe("resolveMailCredentials (M8/M10 worker seam)", () => {
  it("resolves a keyring-stored username/password pair when both env vars are unset", async () => {
    const result = await resolveMailCredentials(envFor());
    expect(result).toEqual({ enabled: true, username: USERNAME, password: PASSWORD });
  });

  it("both env vars WIN over a present keyring pair (env precedence)", async () => {
    const result = await resolveMailCredentials(envFor({ LOOMBRE_SMTP_USERNAME: "env-user", LOOMBRE_SMTP_PASSWORD: "env-pass" }));
    expect(result).toEqual({ enabled: true, username: "env-user", password: "env-pass" });
  });

  it("a lone half-set env var (username only) falls through to the keyring, never a partial-env credential pair", async () => {
    const result = await resolveMailCredentials(envFor({ LOOMBRE_SMTP_USERNAME: "env-user-only" }));
    expect(result).toEqual({ enabled: true, username: USERNAME, password: PASSWORD });
  });

  it("absent everywhere -> disabled, reason names BOTH env vars, never a value", async () => {
    const emptyDataDir = mkdtempSync(path.join(tmpdir(), "loombre-mail-credentials-worker-empty-"));
    try {
      const result = await resolveMailCredentials(envFor({ LOOMBRE_DATA_DIR: emptyDataDir }));
      expect(result.enabled).toBe(false);
      if (!result.enabled) {
        expect(result.reason).toContain("LOOMBRE_SMTP_USERNAME");
        expect(result.reason).toContain("LOOMBRE_SMTP_PASSWORD");
        expect(result.reason).not.toContain(PASSWORD);
      }
    } finally {
      rmSync(emptyDataDir, { recursive: true, force: true });
    }
  });

  it("a malformed keyring envelope degrades to disabled — never a crash", async () => {
    const malformedDataDir = mkdtempSync(path.join(tmpdir(), "loombre-mail-credentials-worker-malformed-"));
    try {
      const secretsDir = path.join(malformedDataDir, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(path.join(secretsDir, "mail-smtp-credentials"), "not json at all", { mode: 0o600 });
      const result = await resolveMailCredentials(envFor({ LOOMBRE_DATA_DIR: malformedDataDir }));
      expect(result.enabled).toBe(false);
    } finally {
      rmSync(malformedDataDir, { recursive: true, force: true });
    }
  });

  it("an inner envelope missing password degrades to disabled — never a crash", async () => {
    const partialDataDir = mkdtempSync(path.join(tmpdir(), "loombre-mail-credentials-worker-partial-"));
    try {
      const backend = (await detectSecretBackend()).backend;
      await storeSecret(
        backend,
        `${partialDataDir}/secrets/mail-smtp-credentials`,
        JSON.stringify({ value: JSON.stringify({ username: "only-user" }), setAtMs: Date.now() }),
      );
      const result = await resolveMailCredentials(envFor({ LOOMBRE_DATA_DIR: partialDataDir }));
      expect(result.enabled).toBe(false);
    } finally {
      rmSync(partialDataDir, { recursive: true, force: true });
    }
  });
});
