// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/contract/test/admin-only-event-types-parity.spec.ts
//
// L3 (owner brief), adjudication C-4. envelope.schema.json is a JSON
// Schema artifact — it cannot import TypeScript, so the admin-only
// event-type classification lives there only as a machine-readable mirror
// (`x-loombre-admin-only-event-types`, event-schemas/README.md "Admin-only
// event types"). This is the automated PARITY GATE: it diffs that mirror
// against the real canonical list
// (packages/shared/src/admin-only-event-types.ts) on every test run and
// fails on ANY delta, naming both files and the differing entries (via
// admin-only-parity-diff.ts's diffAdminOnlyEventTypes/
// formatAdminOnlyParityMessage — see admin-only-parity-diff.spec.ts for
// the unit-tested failure-message shape).
//
// packages/contract depends on @loombre/shared as a devDependency only
// (test-time, not shipped — packages/contract ships no importable code at
// all, see scripts/check-runtime-imports.mjs's RUNTIME_EXEMPT comment);
// acyclic (packages/shared has no dependency back on packages/contract).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_ONLY_EVENT_TYPES } from "@loombre/shared/admin-only-event-types";
import { diffAdminOnlyEventTypes, formatAdminOnlyParityMessage } from "./admin-only-parity-diff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, "../event-schemas");

const CANONICAL_FILE = "packages/shared/src/admin-only-event-types.ts";
const SCHEMA_FILE = "packages/contract/event-schemas/envelope.schema.json";

interface EnvelopeSchemaShape {
  "x-loombre-admin-only-event-types"?: string[];
}

function loadEnvelopeAdminOnlyMirror(): string[] {
  const raw = readFileSync(path.join(SCHEMAS_DIR, "envelope.schema.json"), "utf8");
  const parsed = JSON.parse(raw) as EnvelopeSchemaShape;
  const mirror = parsed["x-loombre-admin-only-event-types"];
  if (!Array.isArray(mirror)) {
    throw new Error(`${SCHEMA_FILE} is missing its x-loombre-admin-only-event-types array`);
  }
  return mirror;
}

describe("admin-only event-type parity (canonical TS list vs. contract x- mirror)", () => {
  it("envelope.schema.json's x-loombre-admin-only-event-types matches packages/shared/src/admin-only-event-types.ts exactly", () => {
    const schemaMirror = loadEnvelopeAdminOnlyMirror();
    const diff = diffAdminOnlyEventTypes(ADMIN_ONLY_EVENT_TYPES, schemaMirror);
    const message = formatAdminOnlyParityMessage(diff, CANONICAL_FILE, SCHEMA_FILE);
    // Asserting the message itself (not just the diff object) so a
    // failure prints the full "both files + differing entries" text
    // directly in the test output — no need to inspect a separate diff
    // structure to see what drifted.
    expect(message, message).toBeUndefined();
  });

  it("the schema mirror carries no duplicate entries (set semantics in the diff would hide them — Lane R F9)", () => {
    // The canonical side has its own no-duplicates test in
    // packages/shared/test; the mirror side needs one too, because
    // diffAdminOnlyEventTypes compares Sets and a duplicated schema entry
    // would otherwise be invisible to the parity gate.
    const schemaMirror = loadEnvelopeAdminOnlyMirror();
    expect(new Set(schemaMirror).size, `duplicate entries in ${SCHEMA_FILE}'s x-loombre-admin-only-event-types`).toBe(
      schemaMirror.length,
    );
  });
});
