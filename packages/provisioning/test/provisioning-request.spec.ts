// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { PROVISIONING_REQUEST_SCHEMA, type ProvisioningRequest } from "../src/provisioning-request.js";

function baseFixture(): ProvisioningRequest {
  return {
    pgMajor: 17,
    pgFullVersion: "17.4",
    dataDir: "/var/lib/loombre/pgdata",
    listenStrategy: { kind: "unix-socket", socketDir: "/var/lib/loombre/pg-sock" },
    locale: "en_US.UTF-8",
    encoding: "UTF8",
    superuserSecretRef: { backend: "file0600", key: "/var/lib/loombre/secrets/pg-superuser" },
  } satisfies ProvisioningRequest;
}

describe("PROVISIONING_REQUEST_SCHEMA", () => {
  const validate = compile(PROVISIONING_REQUEST_SCHEMA);

  it("accepts a well-formed unix-socket request", () => {
    expect(validate(baseFixture()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a well-formed tcp-loopback + Windows dataDir/DPAPI request", () => {
    const fixture: ProvisioningRequest = {
      ...baseFixture(),
      dataDir: "C:\\ProgramData\\Loombre\\pgdata",
      listenStrategy: { kind: "tcp-loopback", port: 54329 },
      superuserSecretRef: { backend: "dpapi", key: "C:\\ProgramData\\Loombre\\secrets\\pg.blob" },
    };
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects pgMajor below the D1 pin floor", () => {
    expect(validate({ ...baseFixture(), pgMajor: 16 })).toBe(false);
  });

  it("rejects a malformed pgFullVersion", () => {
    expect(validate({ ...baseFixture(), pgFullVersion: "17" })).toBe(false);
    expect(validate({ ...baseFixture(), pgFullVersion: "not-a-version" })).toBe(false);
  });

  it("rejects a relative dataDir", () => {
    expect(validate({ ...baseFixture(), dataDir: "relative/pgdata" })).toBe(false);
  });

  it("rejects an encoding other than UTF8", () => {
    expect(validate({ ...baseFixture(), encoding: "LATIN1" })).toBe(false);
  });

  it("rejects a plaintext password field standing in for superuserSecretRef", () => {
    const invalid: Record<string, unknown> = { ...baseFixture(), superuserPassword: "hunter2" };
    delete invalid.superuserSecretRef;
    expect(validate(invalid)).toBe(false);
  });

  it("rejects a missing required field", () => {
    const invalid: Record<string, unknown> = { ...baseFixture() };
    delete invalid.locale;
    expect(validate(invalid)).toBe(false);
  });
});
