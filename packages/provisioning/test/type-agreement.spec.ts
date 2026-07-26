// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/test/type-agreement.spec.ts
//
// Proves the exported TS closed-enum TYPES and the JSON-schema `enum`
// arrays cannot silently diverge, two independent ways:
//
//  1. expectTypeOf(...).toEqualTypeOf(...) — compile-time proof that each
//     TS union type is EXACTLY `(typeof ARRAY)[number]` (not a superset or
//     subset). Because every schema's `enum` field is built by spreading
//     that same const array (see each src/*.ts), agreement is true by
//     construction; this is the regression guard for that construction
//     ever being bypassed.
//  2. `@ts-expect-error` on a bad literal — compile-time proof the closed
//     type actually rejects a value outside the enum. TypeScript reports
//     "Unused '@ts-expect-error' directive" as a hard error if the
//     following line does NOT error, so this fails loudly if the type
//     were ever accidentally widened (e.g. to `string`).
//
// Both only matter if something runs `tsc` over this file: see
// tsconfig.test.json and package.json's `typecheck` script, which chains
// it in specifically so `pnpm gate` enforces these, not just an IDE.

import { describe, expect, it, expectTypeOf } from "vitest";

import { SECRET_BACKENDS, type SecretBackend, type SecretRef } from "../src/secret-ref.js";
import { LISTEN_STRATEGY_KINDS, type ListenStrategy } from "../src/listen-strategy.js";
import { PROVISIONING_STATES, type ProvisioningState } from "../src/provisioning-status.js";
import { UPGRADE_STEPS, type UpgradeStep } from "../src/upgrade-plan.js";
import { CORRUPTION_REASONS, type CorruptionReason } from "../src/corruption-report.js";

import { SECRET_REF_SCHEMA } from "../src/secret-ref.js";
import { PROVISIONING_STATUS_SCHEMA } from "../src/provisioning-status.js";
import { UPGRADE_PLAN_SCHEMA } from "../src/upgrade-plan.js";
import { CORRUPTION_REPORT_SCHEMA } from "../src/corruption-report.js";

describe("closed-enum agreement: TS union types vs runtime arrays", () => {
  it("SecretBackend === (typeof SECRET_BACKENDS)[number]", () => {
    expectTypeOf<(typeof SECRET_BACKENDS)[number]>().toEqualTypeOf<SecretBackend>();
  });

  it("ListenStrategy['kind'] === (typeof LISTEN_STRATEGY_KINDS)[number]", () => {
    expectTypeOf<(typeof LISTEN_STRATEGY_KINDS)[number]>().toEqualTypeOf<ListenStrategy["kind"]>();
  });

  it("ProvisioningState === (typeof PROVISIONING_STATES)[number]", () => {
    expectTypeOf<(typeof PROVISIONING_STATES)[number]>().toEqualTypeOf<ProvisioningState>();
  });

  it("UpgradeStep === (typeof UPGRADE_STEPS)[number]", () => {
    expectTypeOf<(typeof UPGRADE_STEPS)[number]>().toEqualTypeOf<UpgradeStep>();
  });

  it("CorruptionReason === (typeof CORRUPTION_REASONS)[number]", () => {
    expectTypeOf<(typeof CORRUPTION_REASONS)[number]>().toEqualTypeOf<CorruptionReason>();
  });
});

describe("closed-enum agreement: runtime arrays vs the schemas' own enum fields", () => {
  it("SECRET_REF_SCHEMA.properties.backend.enum === SECRET_BACKENDS", () => {
    expect(SECRET_REF_SCHEMA.properties.backend.enum).toEqual(SECRET_BACKENDS);
  });

  it("PROVISIONING_STATUS_SCHEMA.properties.state.enum === PROVISIONING_STATES", () => {
    expect(PROVISIONING_STATUS_SCHEMA.properties.state.enum).toEqual(PROVISIONING_STATES);
  });

  it("UPGRADE_PLAN_SCHEMA's steps item enum === UPGRADE_STEPS", () => {
    expect(UPGRADE_PLAN_SCHEMA.properties.steps.items.enum).toEqual(UPGRADE_STEPS);
  });

  it("CORRUPTION_REPORT_SCHEMA.properties.reason.enum === CORRUPTION_REASONS", () => {
    expect(CORRUPTION_REPORT_SCHEMA.properties.reason.enum).toEqual(CORRUPTION_REASONS);
  });
});

describe("closed-enum agreement: TS rejects out-of-enum literals (compile-time)", () => {
  it("SecretRef.backend rejects a non-member string literal", () => {
    // @ts-expect-error 'ntfs-acl' is not a member of SecretBackend. If this
    // stops erroring, SecretRef/SECRET_BACKENDS and SECRET_REF_SCHEMA's
    // enum have silently diverged.
    void ({ backend: "ntfs-acl", key: "k" } satisfies SecretRef);
    expect(true).toBe(true);
  });

  it("UpgradeStep rejects a non-member string literal", () => {
    // @ts-expect-error 'vacuum-full' is not a member of UpgradeStep.
    const bad: UpgradeStep[] = ["vacuum-full"];
    void bad;
    expect(true).toBe(true);
  });

  it("CorruptionReason rejects a prose-shaped string literal", () => {
    // @ts-expect-error prose is never a valid CorruptionReason.
    const bad: CorruptionReason = "the disk fell over";
    void bad;
    expect(true).toBe(true);
  });
});
