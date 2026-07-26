// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  CORRUPTION_REASONS,
  CORRUPTION_REPORT_SCHEMA,
  type CorruptionReport,
} from "../src/corruption-report.js";

describe("CORRUPTION_REPORT_SCHEMA", () => {
  const validate = compile(CORRUPTION_REPORT_SCHEMA);

  it("accepts every closed reason with a satisfies-typed fixture", () => {
    for (const reason of CORRUPTION_REASONS) {
      const fixture = {
        reason,
        dataDir: "/var/lib/loombre/pgdata",
        detectedAtMs: 1_800_000_000_000,
      } satisfies CorruptionReport;
      expect(validate(fixture), `${reason}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("accepts the optional detail field as supplementary text", () => {
    const fixture = {
      reason: "checksum-failure",
      dataDir: "/var/lib/loombre/pgdata",
      detectedAtMs: 1_800_000_000_000,
      detail: "page verification failed: calculated checksum 1234 but expected 5678",
    } satisfies CorruptionReport;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a reason outside the closed enum (no prose-only errors)", () => {
    expect(
      validate({
        reason: "the disk fell over",
        dataDir: "/var/lib/loombre/pgdata",
        detectedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("rejects a relative dataDir", () => {
    expect(validate({ reason: "unknown", dataDir: "pgdata", detectedAtMs: 0 })).toBe(false);
  });

  it("rejects a missing detectedAtMs", () => {
    expect(validate({ reason: "unknown", dataDir: "/var/lib/loombre/pgdata" })).toBe(false);
  });
});
