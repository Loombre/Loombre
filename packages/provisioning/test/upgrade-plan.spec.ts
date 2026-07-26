// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { UPGRADE_PLAN_SCHEMA, UPGRADE_STEPS, type UpgradePlan } from "../src/upgrade-plan.js";

function baseFixture(): UpgradePlan {
  return {
    fromVersion: "17.4",
    toVersion: "18.0",
    backupPath: "/var/lib/loombre/backups/pre-upgrade-17.4.dump",
    steps: [...UPGRADE_STEPS],
  } satisfies UpgradePlan;
}

describe("UPGRADE_PLAN_SCHEMA", () => {
  const validate = compile(UPGRADE_PLAN_SCHEMA);

  it("accepts the full canonical step sequence", () => {
    expect(validate(baseFixture()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a single-step plan (e.g. a plan that only needs 'verify')", () => {
    const fixture: UpgradePlan = { ...baseFixture(), steps: ["verify"] };
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a step outside the closed enum", () => {
    const invalid = { ...baseFixture(), steps: ["stop", "vacuum-full"] };
    expect(validate(invalid)).toBe(false);
  });

  it("rejects a duplicate step (uniqueItems)", () => {
    const invalid = { ...baseFixture(), steps: ["stop", "stop", "backup"] };
    expect(validate(invalid)).toBe(false);
  });

  it("rejects an empty steps array", () => {
    expect(validate({ ...baseFixture(), steps: [] })).toBe(false);
  });

  it("rejects a malformed fromVersion/toVersion", () => {
    expect(validate({ ...baseFixture(), fromVersion: "v17" })).toBe(false);
    expect(validate({ ...baseFixture(), toVersion: "" })).toBe(false);
  });

  it("rejects a relative backupPath", () => {
    expect(validate({ ...baseFixture(), backupPath: "backups/dump.sql" })).toBe(false);
  });
});
