// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/test/type-agreement.spec.ts — see
// packages/provisioning/test/type-agreement.spec.ts for the full rationale
// (expectTypeOf for bidirectional type equality + @ts-expect-error to
// prove the closed type actually rejects out-of-enum literals; both only
// enforced because tsconfig.test.json chains into `pnpm typecheck`).
//
// Why JOB_TYPES specifically needs this (Fix Wave 4 residual): its
// `as const satisfies readonly JobType[]` declaration proves SUBSET only
// (every element IS a JobType) — it can never catch an OMISSION. queue.ts
// iterates JOB_TYPES to createQueue/updateQueue at startup, so a JobType
// silently dropped from the array gets no pg-boss queue and every job of
// that type is unenqueueable. The expectTypeOf below makes that omission
// a compile error.

import { describe, expect, it, expectTypeOf } from "vitest";

import { JOB_TYPES, type JobType } from "../src/types.js";

describe("closed-enum agreement: JobType vs JOB_TYPES", () => {
  it("JobType === (typeof JOB_TYPES)[number] (bidirectional — catches omission AND foreign members)", () => {
    expectTypeOf<(typeof JOB_TYPES)[number]>().toEqualTypeOf<JobType>();
  });

  it("JOB_TYPES has no duplicate members", () => {
    expect(new Set(JOB_TYPES).size).toBe(JOB_TYPES.length);
  });
});

describe("closed-enum agreement: TS rejects out-of-enum literals (compile-time)", () => {
  it("JobType rejects a non-member string literal", () => {
    // @ts-expect-error 'mail-recieve' is not a member of JobType. If this
    // stops erroring, JobType has silently widened (e.g. to string).
    const bad: JobType = "mail-recieve";
    void bad;
    expect(true).toBe(true);
  });
});
