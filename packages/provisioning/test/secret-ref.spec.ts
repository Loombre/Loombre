// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { SECRET_REF_SCHEMA, type SecretRef } from "../src/secret-ref.js";

describe("SECRET_REF_SCHEMA", () => {
  const validate = compile(SECRET_REF_SCHEMA);

  it("accepts every closed backend with a satisfies-typed fixture", () => {
    const fixtures = [
      { backend: "keychain", key: "com.loombre.server/pg-superuser" } satisfies SecretRef,
      { backend: "dpapi", key: "C:\\ProgramData\\Loombre\\secrets\\pg.blob" } satisfies SecretRef,
      { backend: "libsecret", key: "loombre-pg-superuser" } satisfies SecretRef,
      { backend: "file0600", key: "/var/lib/loombre/secrets/pg-superuser" } satisfies SecretRef,
    ];
    for (const fixture of fixtures) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects a backend outside the closed enum", () => {
    expect(validate({ backend: "windows-credential-manager", key: "x" })).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(validate({ backend: "keychain", key: "" })).toBe(false);
  });

  it("rejects a missing key", () => {
    expect(validate({ backend: "keychain" })).toBe(false);
  });

  it("rejects a plaintext-looking extra property (additionalProperties: false)", () => {
    expect(validate({ backend: "keychain", key: "x", plaintextPassword: "hunter2" })).toBe(false);
  });
});
