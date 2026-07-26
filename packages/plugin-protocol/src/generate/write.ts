// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/generate/write.ts
//
// Filesystem half of the `generate` script — kept separate from
// json-schema.ts/spec.ts (which stay pure string-in/string-out) so the
// drift tests can call the pure generators directly without touching disk.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeLppJsonSchemaDocument } from "./json-schema.js";
import { generateLppSpecMarkdown } from "./spec.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LPP_SPEC_MARKDOWN_PATH = join(PACKAGE_ROOT, "spec", "lpp-v1.md");
export const LPP_JSON_SCHEMA_PATH = join(PACKAGE_ROOT, "spec", "schemas", "lpp-v1.schemas.json");

export function writeLppGeneratedArtifacts(): void {
  mkdirSync(dirname(LPP_JSON_SCHEMA_PATH), { recursive: true });
  writeFileSync(LPP_JSON_SCHEMA_PATH, serializeLppJsonSchemaDocument());
  writeFileSync(LPP_SPEC_MARKDOWN_PATH, generateLppSpecMarkdown());
}
