// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/generate/json-schema.ts
//
// Builds the committed JSON Schema artifact (spec/schemas/lpp-v1.schemas.json)
// from this package's zod schemas via `z.toJSONSchema` — the same
// projection mechanism packages/shared/src/settings-registry.ts uses (AD3).
// One function, `generateLppJsonSchemaDocument`, is the single source both
// the `generate` CLI (write.ts) and the drift test (test/json-schema-
// drift.spec.ts) call — the committed file is only ever a serialization of
// this function's return value, never hand-edited.

import { z } from "zod";
import { LppManifestSchema } from "../envelope.js";
import { LppConfigSchema } from "../json-schema-subset.js";
import { LppProblemSchema } from "../problem.js";
import {
  LppCapabilitySchema,
  LppDetailsRequestSchema,
  LppDetailsResponseSchema,
  LppEventBatchSchema,
  LppEventSubscriberCapabilitySchema,
  LppImagesRequestSchema,
  LppImagesResponseSchema,
  LppMetadataProviderCapabilitySchema,
  LppSearchRequestSchema,
  LppSearchResponseSchema,
} from "../capabilities/index.js";
import { LPP_PROTOCOL_VERSION } from "../version.js";

/** Ordered name -> zod schema map. Order is significant: it is the order
 *  both the JSON artifact's `schemas` object and the generated spec
 *  document's schema listing render in, so it is deliberately curated
 *  (envelope, then capabilities, then per-capability wire shapes, then
 *  cross-cutting shapes) rather than alphabetical. */
export const LPP_JSON_SCHEMA_SOURCES: ReadonlyArray<readonly [name: string, schema: z.ZodType]> = [
  ["ManifestEnvelope", LppManifestSchema],
  ["ConfigSchema", LppConfigSchema],
  ["Capability", LppCapabilitySchema],
  ["MetadataProviderCapability", LppMetadataProviderCapabilitySchema],
  ["EventSubscriberCapability", LppEventSubscriberCapabilitySchema],
  ["MetadataProviderSearchRequest", LppSearchRequestSchema],
  ["MetadataProviderSearchResponse", LppSearchResponseSchema],
  ["MetadataProviderDetailsRequest", LppDetailsRequestSchema],
  ["MetadataProviderDetailsResponse", LppDetailsResponseSchema],
  ["MetadataProviderImagesRequest", LppImagesRequestSchema],
  ["MetadataProviderImagesResponse", LppImagesResponseSchema],
  ["EventSubscriberBatch", LppEventBatchSchema],
  ["Problem", LppProblemSchema],
];

export interface LppJsonSchemaDocument {
  generatedFrom: string;
  protocolVersion: number;
  schemas: Record<string, unknown>;
}

export function generateLppJsonSchemaDocument(): LppJsonSchemaDocument {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of LPP_JSON_SCHEMA_SOURCES) {
    schemas[name] = z.toJSONSchema(schema);
  }
  return {
    generatedFrom:
      "packages/plugin-protocol/src (do not hand-edit — run `pnpm --filter @loombre/plugin-protocol run generate`)",
    protocolVersion: LPP_PROTOCOL_VERSION,
    schemas,
  };
}

/** Deterministic (stable key order, trailing newline) serialization — the
 *  exact bytes the drift test compares against the committed file. */
export function serializeLppJsonSchemaDocument(): string {
  return `${JSON.stringify(generateLppJsonSchemaDocument(), null, 2)}\n`;
}
