// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/problem.spec.ts

import { describe, expect, it } from "vitest";
import { LPP_PROBLEM_TYPES, LppProblemSchema, lppProblem } from "../src/problem.js";

describe("LppProblemSchema", () => {
  it("accepts a minimal problem (only required fields)", () => {
    expect(LppProblemSchema.safeParse({ title: "Unprocessable Entity", status: 422 }).success).toBe(true);
  });

  it("accepts a full problem with extension members (additive, passthrough)", () => {
    const result = LppProblemSchema.safeParse({
      type: LPP_PROBLEM_TYPES.validation,
      title: "Unprocessable Entity",
      status: 422,
      detail: "mediaKind is invalid",
      instance: "/lpp/provider/search",
      code: "invalid-media-kind",
      extraVendorField: "kept, not stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.extraVendorField).toBe("kept, not stripped");
  });

  it("rejects a problem missing 'title'", () => {
    expect(LppProblemSchema.safeParse({ status: 422 }).success).toBe(false);
  });

  it("rejects a status outside the 100-599 range", () => {
    expect(LppProblemSchema.safeParse({ title: "x", status: 999 }).success).toBe(false);
  });
});

describe("lppProblem", () => {
  it("builds a problem body with only the provided optional fields", () => {
    const problem = lppProblem({ type: LPP_PROBLEM_TYPES.notFound, title: "Not Found", status: 404 });
    expect(problem).toEqual({ type: LPP_PROBLEM_TYPES.notFound, title: "Not Found", status: 404 });
    expect(LppProblemSchema.safeParse(problem).success).toBe(true);
  });
});
