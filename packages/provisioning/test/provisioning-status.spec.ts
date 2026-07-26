// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  PROVISIONING_STATES,
  PROVISIONING_STATUS_SCHEMA,
  type ProvisioningStatus,
} from "../src/provisioning-status.js";

describe("PROVISIONING_STATUS_SCHEMA", () => {
  const validate = compile(PROVISIONING_STATUS_SCHEMA);

  it("accepts every closed state with a satisfies-typed fixture", () => {
    for (const state of PROVISIONING_STATES) {
      const fixture = {
        state,
        pgVersion: state === "absent" || state === "external" ? null : "17.4",
        dataDir: state === "absent" || state === "external" ? null : "/var/lib/loombre/pgdata",
        lastCheckMs: 1_800_000_000_000,
      } satisfies ProvisioningStatus;
      expect(validate(fixture), `${state}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("accepts the optional detail field", () => {
    const fixture = {
      state: "corrupt",
      pgVersion: "17.4",
      dataDir: "/var/lib/loombre/pgdata",
      lastCheckMs: 1_800_000_000_000,
      detail: "PG_VERSION missing",
    } satisfies ProvisioningStatus;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a state outside the closed enum", () => {
    expect(
      validate({ state: "installing", pgVersion: null, dataDir: null, lastCheckMs: 0 }),
    ).toBe(false);
  });

  it("rejects a missing pgVersion/dataDir (both required, even when null)", () => {
    expect(validate({ state: "absent", lastCheckMs: 0 })).toBe(false);
  });

  it("rejects a negative lastCheckMs", () => {
    expect(validate({ state: "absent", pgVersion: null, dataDir: null, lastCheckMs: -1 })).toBe(
      false,
    );
  });
});
