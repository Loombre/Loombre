// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/envelope.ts
//
// C2: `GET /lpp/manifest` -> `{ name, version, protocolVersion, capabilities,
// configSchema, description, publisher }`. This is the FROZEN envelope
// (mission: "the envelope never changes" — C8 additivity applies to
// `capabilities`' member types, never to this object's own field set).
//
// Two schemas are exported for two different jobs:
//   - `LppManifestSchema`: the strict, fully-typed shape (discriminated-union
//     capabilities, validated configSchema) — used for JSON Schema
//     generation (generate/json-schema.ts), fixture tests, and any caller
//     that already knows its input is well-formed.
//   - `parseLppManifest`: a STAGED parser returning a typed
//     `LppManifestParseResult` that can distinguish an unrecognized
//     `protocolVersion` and per-capability unknown-type/invalid-shape
//     failures from a generic envelope-shape error — exactly what C2's
//     "clear 'this Loombre doesn't support X yet', never silently ignored"
//     requirement and the conformance suite both need, and what a single
//     `LppManifestSchema.safeParse()` call cannot give them (a zod
//     discriminated-union failure on one bad capability entry does not by
//     itself say WHY that entry failed).

import { z } from "zod";
import {
  LppConfigSchema,
  checkConfigSchemaBounds,
  findSecretBelowRoot,
  type LppConfig,
  type ConfigSchemaBoundsViolation,
} from "./json-schema-subset.js";
import { LPP_PROTOCOL_VERSION } from "./version.js";
import {
  LppCapabilitySchema,
  parseLppCapabilities,
  type LppCapability,
  type LppCapabilityParseResult,
} from "./capabilities/index.js";

export const LppManifestSchema = z
  .object({
    name: z.string().min(1),
    /** The PLUGIN's own version (e.g. semver) — distinct from `protocolVersion`. */
    version: z.string().min(1),
    protocolVersion: z.literal(LPP_PROTOCOL_VERSION),
    capabilities: z.array(LppCapabilitySchema).min(1),
    /** Always present; a plugin with no configurable fields still returns
     *  `{ type: "object", properties: {}, additionalProperties: false }`
     *  (json-schema-subset.ts's `LPP_EMPTY_CONFIG_SCHEMA`) rather than
     *  omitting the field. */
    configSchema: LppConfigSchema,
    description: z.string().min(1),
    publisher: z.string().min(1),
  })
  .strict();

export type LppManifest = z.infer<typeof LppManifestSchema>;

// ============================================================================
// staged parse
// ============================================================================

/** Loose shape used only to validate the envelope's non-capability fields
 *  before capabilities are parsed one-by-one — deliberately does NOT
 *  validate `capabilities`/`configSchema` contents (that happens next). */
const LppManifestEnvelopeShapeSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.number(),
    capabilities: z.array(z.unknown()).min(1),
    configSchema: z.unknown(),
    description: z.string().min(1),
    publisher: z.string().min(1),
  })
  .strict();

export type LppManifestParseResult =
  | { ok: true; manifest: LppManifest }
  | { ok: false; stage: "envelope"; issues: z.core.$ZodIssue[] }
  | { ok: false; stage: "protocol-version"; found: number }
  | {
      ok: false;
      stage: "capabilities";
      unknownTypes: string[];
      /** C-1 fix wave: `type` values declared more than once — see
       *  capabilities/index.ts's parseLppCapabilities doc comment. */
      duplicateTypes: string[];
      results: LppCapabilityParseResult[];
    }
  | { ok: false; stage: "config-schema"; issues: z.core.$ZodIssue[] }
  /** M-2 fix wave: the RAW configSchema exceeded a structural bound
   *  (recursion depth, enum length, properties/required cardinality)
   *  BEFORE it was ever handed to zod — see json-schema-subset.ts's
   *  checkConfigSchemaBounds header. */
  | { ok: false; stage: "config-schema-bounds"; violation: ConfigSchemaBoundsViolation }
  /** H-1 fix wave: a `secret: true` marker appeared below the configSchema
   *  root — see json-schema-subset.ts's findSecretBelowRoot header. */
  | { ok: false; stage: "config-schema-secret-placement"; paths: string[] };

/**
 * Staged manifest parse (see file header). Order: envelope shape ->
 * protocolVersion -> capabilities (unknown-type/duplicate-type-aware) ->
 * configSchema (structural bounds -> shape -> secret placement). The first
 * failing stage short-circuits — this mirrors how a real registration flow
 * should behave: an unsupported protocol version makes capability details
 * moot, and unknown/duplicate capability types are worth reporting
 * precisely before a generic configSchema error buries them.
 *
 * Never throws for an ordinary failure mode (M-2 fix wave) — every
 * rejection, INCLUDING a configSchema deep/wide enough to have previously
 * exhausted the JS call stack inside zod's own recursive validation, comes
 * back as a typed `{ ok: false, ... }` result.
 */
export function parseLppManifest(raw: unknown): LppManifestParseResult {
  const envelope = LppManifestEnvelopeShapeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, stage: "envelope", issues: envelope.error.issues };
  }
  const { data } = envelope;

  if (data.protocolVersion !== LPP_PROTOCOL_VERSION) {
    return { ok: false, stage: "protocol-version", found: data.protocolVersion };
  }

  const capabilitiesResult = parseLppCapabilities(data.capabilities);
  if (capabilitiesResult.hasErrors) {
    return {
      ok: false,
      stage: "capabilities",
      unknownTypes: capabilitiesResult.unknownTypes,
      duplicateTypes: capabilitiesResult.duplicateTypes,
      results: capabilitiesResult.results,
    };
  }

  // M-2: bound structure BEFORE zod recurses into it (this walker's own
  // recursion is bounded regardless of how deep/wide `data.configSchema`
  // actually is — see checkConfigSchemaBounds's header).
  const boundsViolation = checkConfigSchemaBounds(data.configSchema);
  if (boundsViolation) {
    return { ok: false, stage: "config-schema-bounds", violation: boundsViolation };
  }

  let configSchemaResult: ReturnType<typeof LppConfigSchema.safeParse>;
  try {
    configSchemaResult = LppConfigSchema.safeParse(data.configSchema);
  } catch {
    // Defense in depth only — checkConfigSchemaBounds above should make
    // this unreachable. A RangeError here (or any other unexpected throw)
    // still comes back as a typed result, never propagates.
    return { ok: false, stage: "config-schema-bounds", violation: { path: "", reason: "max-depth-exceeded" } };
  }
  if (!configSchemaResult.success) {
    return { ok: false, stage: "config-schema", issues: configSchemaResult.error.issues };
  }

  // H-1: reject secret:true anywhere below the configSchema root.
  const secretPlacementViolations = findSecretBelowRoot(configSchemaResult.data as LppConfig);
  if (secretPlacementViolations.length > 0) {
    return { ok: false, stage: "config-schema-secret-placement", paths: secretPlacementViolations };
  }

  const manifest: LppManifest = {
    name: data.name,
    version: data.version,
    protocolVersion: LPP_PROTOCOL_VERSION,
    capabilities: capabilitiesResult.capabilities as LppCapability[],
    configSchema: configSchemaResult.data as LppConfig,
    description: data.description,
    publisher: data.publisher,
  };
  return { ok: true, manifest };
}

/** Human-readable one-liner for a failed `LppManifestParseResult` — used by
 *  the conformance CLI's report and suitable for a host's registration
 *  error surface too (C2's "clear ... message" requirement). */
export function describeLppManifestParseFailure(result: Extract<LppManifestParseResult, { ok: false }>): string {
  switch (result.stage) {
    case "envelope":
      return `manifest envelope is malformed: ${result.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    case "protocol-version":
      return `unsupported protocolVersion ${result.found} — this Loombre only supports LPP v${LPP_PROTOCOL_VERSION}`;
    case "capabilities": {
      const unknown = result.unknownTypes.map((t) => `this Loombre doesn't support capability type '${t}' yet`);
      const duplicate = result.duplicateTypes.map(
        (t) => `capability type '${t}' is declared more than once — at most one entry per type is allowed`,
      );
      const invalid = result.results
        .filter((r): r is Extract<LppCapabilityParseResult, { ok: false; reason: "invalid-capability" }> => !r.ok && r.reason === "invalid-capability")
        .map((r) => `capability '${r.type}' is malformed: ${r.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return [...unknown, ...duplicate, ...invalid].join(" | ");
    }
    case "config-schema":
      return `configSchema is malformed: ${result.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    case "config-schema-bounds":
      return `configSchema exceeds structural limits at '${result.violation.path || "(root)"}' (${result.violation.reason})`;
    case "config-schema-secret-placement":
      return `configSchema declares "secret": true below the root — only a top-level field may be secret (offending path(s): ${result.paths.join(", ")})`;
  }
}
