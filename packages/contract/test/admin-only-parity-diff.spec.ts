// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/admin-only-parity-diff.spec.ts
//
// L3 (owner brief), adjudication C-5(a): unit tests feeding the parity
// helper MUTATED fixture copies (never the real canonical list or the
// real schema file — that's admin-only-event-types-parity.spec.ts) and
// asserting the exact failure-message shape: both file paths named, and
// every differing entry listed under the correct missing/extra heading.
// This is the "demonstrated, not assumed" proof that the parity mechanism
// itself works, independent of whatever the real files currently say.

import { describe, expect, it } from "vitest";
import { diffAdminOnlyEventTypes, formatAdminOnlyParityMessage } from "./admin-only-parity-diff.js";

const CANONICAL_FILE = "packages/shared/src/admin-only-event-types.ts";
const SCHEMA_FILE = "packages/contract/event-schemas/envelope.schema.json";

describe("diffAdminOnlyEventTypes", () => {
  it("reports no diff when both sides are identical (order-independent)", () => {
    const diff = diffAdminOnlyEventTypes(["a", "b", "c"], ["c", "a", "b"]);
    expect(diff).toEqual({ missingFromSchema: [], extraInSchema: [] });
  });

  it("reports an entry present in the canonical list but missing from the schema mirror", () => {
    const diff = diffAdminOnlyEventTypes(["a", "b", "fake.admin-event"], ["a", "b"]);
    expect(diff).toEqual({ missingFromSchema: ["fake.admin-event"], extraInSchema: [] });
  });

  it("reports an entry present in the schema mirror but missing from the canonical list", () => {
    const diff = diffAdminOnlyEventTypes(["a", "b"], ["a", "b", "stale.schema-only"]);
    expect(diff).toEqual({ missingFromSchema: [], extraInSchema: ["stale.schema-only"] });
  });

  it("reports both directions at once, each sorted", () => {
    const diff = diffAdminOnlyEventTypes(["z.canonical-only", "a.canonical-only", "shared"], ["shared", "z.schema-only", "a.schema-only"]);
    expect(diff).toEqual({
      missingFromSchema: ["a.canonical-only", "z.canonical-only"],
      extraInSchema: ["a.schema-only", "z.schema-only"],
    });
  });

  it("collapses duplicates in either input", () => {
    const diff = diffAdminOnlyEventTypes(["a", "a", "b"], ["b", "b"]);
    expect(diff).toEqual({ missingFromSchema: ["a"], extraInSchema: [] });
  });
});

describe("formatAdminOnlyParityMessage", () => {
  it("returns undefined for an empty diff", () => {
    const message = formatAdminOnlyParityMessage({ missingFromSchema: [], extraInSchema: [] }, CANONICAL_FILE, SCHEMA_FILE);
    expect(message).toBeUndefined();
  });

  it("names both files and lists the missing entry (regression proof: a fake admin event added to the canonical fixture, absent from the schema fixture)", () => {
    const diff = diffAdminOnlyEventTypes(
      ["job.updated", "settings.updated", "fake.admin-event"],
      ["job.updated", "settings.updated"],
    );
    const message = formatAdminOnlyParityMessage(diff, CANONICAL_FILE, SCHEMA_FILE);
    expect(message).toBeDefined();
    expect(message).toContain(CANONICAL_FILE);
    expect(message).toContain(SCHEMA_FILE);
    expect(message).toContain("fake.admin-event");
    expect(message).toMatch(/missing from schema/);
    expect(message).not.toMatch(/extra in schema/);
  });

  it("names both files and lists the extra entry when the schema mirror has a stale/extra type", () => {
    const diff = diffAdminOnlyEventTypes(["job.updated"], ["job.updated", "stale.schema-only-event"]);
    const message = formatAdminOnlyParityMessage(diff, CANONICAL_FILE, SCHEMA_FILE);
    expect(message).toBeDefined();
    expect(message).toContain(CANONICAL_FILE);
    expect(message).toContain(SCHEMA_FILE);
    expect(message).toContain("stale.schema-only-event");
    expect(message).toMatch(/extra in schema/);
    expect(message).not.toMatch(/missing from schema/);
  });

  it("lists every differing entry when there are multiple on both sides, not just the first", () => {
    const diff = diffAdminOnlyEventTypes(
      ["shared", "canonical.only-1", "canonical.only-2"],
      ["shared", "schema.only-1", "schema.only-2"],
    );
    const message = formatAdminOnlyParityMessage(diff, CANONICAL_FILE, SCHEMA_FILE);
    expect(message).toContain("canonical.only-1");
    expect(message).toContain("canonical.only-2");
    expect(message).toContain("schema.only-1");
    expect(message).toContain("schema.only-2");
  });
});
