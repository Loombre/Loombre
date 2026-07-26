// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { IPC_ERROR_BODY_SCHEMA, IPC_ERROR_CODES, type IpcErrorBody } from "../src/index.js";

describe("IPC_ERROR_BODY_SCHEMA", () => {
  const validate = compile(IPC_ERROR_BODY_SCHEMA);

  it("accepts every closed code with a satisfies-typed fixture", () => {
    for (const code of IPC_ERROR_CODES) {
      const fixture = {
        title: "Something went wrong",
        status: 409,
        code,
      } satisfies IpcErrorBody;
      expect(validate(fixture), `${code}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects a code outside the closed enum", () => {
    expect(validate({ title: "x", status: 500, code: "boom" })).toBe(false);
  });

  it("rejects a status outside the HTTP range", () => {
    expect(validate({ title: "x", status: 999, code: "internal-error" })).toBe(false);
  });

  it("rejects a missing title", () => {
    expect(validate({ status: 500, code: "internal-error" })).toBe(false);
  });
});
