// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/json-schema-drift.spec.ts
//
// sdk-drift-check style: regenerate the JSON Schema artifact in-memory from
// the current src/ schemas and byte-compare it against the committed file.
// A mismatch means someone edited a schema in src/ without re-running
// `pnpm --filter @loombre/plugin-protocol run generate` — this is the FROZEN
// CONTRACT (mission: "packages/plugin-protocol/spec/lpp-v1.md ... generated
// spec document ... committed, drift-checked"; the JSON Schema artifact is
// held to the same discipline).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeLppJsonSchemaDocument } from "../src/generate/json-schema.js";
import { LPP_JSON_SCHEMA_PATH } from "../src/generate/write.js";

describe("JSON Schema artifact drift", () => {
  it("spec/schemas/lpp-v1.schemas.json matches a fresh regeneration byte-for-byte", () => {
    const committed = readFileSync(LPP_JSON_SCHEMA_PATH, "utf8");
    const regenerated = serializeLppJsonSchemaDocument();
    expect(committed).toBe(regenerated);
  });
});
