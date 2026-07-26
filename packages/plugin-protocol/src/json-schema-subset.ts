// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/json-schema-subset.ts
//
// The manifest `configSchema` field (C2/C3) auto-renders the admin plugin
// config form, EXACTLY the same job packages/shared/src/settings-registry.ts's
// `settingsValueJsonSchema` projection does for server settings (Addendum A,
// AD3: "one source, many consumers", zod-sourced via z.toJSONSchema). This
// module is that same convention, reused rather than reinvented (mission
// instruction: "do not invent a divergent widget vocabulary").
//
// The registry's real entries (packages/shared/src/settings-registry.ts,
// surveyed exhaustively for this file) only ever emit five JSON-Schema
// shapes through z.toJSONSchema: string, number/integer (optionally bounded
// by minimum/maximum), boolean, string-enum, array (of a primitive or of one
// nested object level — see LADDER_RUNG_SCHEMA), and object (properties +
// required + additionalProperties:false). No oneOf/anyOf/$ref/nullable
// shape appears anywhere in that registry. This module's
// `LppConfigFieldSchema` is a recursive zod validator over exactly that
// closed vocabulary — a plugin's configSchema that used anything outside it
// (e.g. a raw `oneOf`) is REJECTED, keeping the admin form renderer's job
// bounded to widgets it already knows how to draw for server settings.
//
// One LPP-specific extension keyword is added on top of that vocabulary:
// `secret` (C3 — "Fields marked `secret: true` live in the server keyring").
// It is legal only on `type: "string"` leaves: the header encoding this
// package defines (headers.ts) delivers a secret's value as a single
// string (`X-LPP-Secret-<NAME>`), so a secret-marked number/boolean/array/
// object field would have no defined wire representation.

import { z } from "zod";

const descriptionField = z.string().min(1).optional();

export const LppConfigStringFieldSchema = z
  .object({
    type: z.literal("string"),
    description: descriptionField,
    enum: z.array(z.string()).min(1).optional(),
    const: z.string().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    default: z.string().optional(),
    /** LPP extension, not standard JSON Schema (see file header). */
    secret: z.boolean().optional(),
  })
  .strict();

export const LppConfigNumberFieldSchema = z
  .object({
    type: z.enum(["number", "integer"]),
    description: descriptionField,
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  })
  .strict();

export const LppConfigBooleanFieldSchema = z
  .object({
    type: z.literal("boolean"),
    description: descriptionField,
    default: z.boolean().optional(),
  })
  .strict();

// Optional fields are typed `T | undefined` explicitly, not bare `T`: with
// `exactOptionalPropertyTypes: true` (this repo's tsconfig.base.json), a
// bare `field?: T` forbids an explicit `undefined` value, but zod's own
// `.optional()` output type is always `T | undefined` — these interfaces
// back the corresponding zod schemas below (LppConfigArrayFieldSchema/
// LppConfigObjectFieldSchema), so they must match that shape exactly.
export interface LppConfigArrayField {
  type: "array";
  description?: string | undefined;
  items: LppConfigFieldNode;
  minItems?: number | undefined;
  maxItems?: number | undefined;
}

export interface LppConfigObjectField {
  type: "object";
  description?: string | undefined;
  properties: Record<string, LppConfigFieldNode>;
  required?: string[] | undefined;
  additionalProperties: false;
}

export type LppConfigFieldNode =
  | z.infer<typeof LppConfigStringFieldSchema>
  | z.infer<typeof LppConfigNumberFieldSchema>
  | z.infer<typeof LppConfigBooleanFieldSchema>
  | LppConfigArrayField
  | LppConfigObjectField;

export const LppConfigArrayFieldSchema: z.ZodType<LppConfigArrayField> = z.lazy(() =>
  z
    .object({
      type: z.literal("array"),
      description: descriptionField,
      items: LppConfigFieldSchema,
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
    })
    .strict(),
);

export const LppConfigObjectFieldSchema: z.ZodType<LppConfigObjectField> = z.lazy(() =>
  z
    .object({
      type: z.literal("object"),
      description: descriptionField,
      properties: z.record(z.string(), LppConfigFieldSchema),
      required: z.array(z.string()).optional(),
      // Mirrors the registry's own object emission (settings-registry.ts's
      // LADDER_RUNG_SCHEMA -> additionalProperties: false verbatim) — a
      // plugin config object is always closed, never an open bag.
      additionalProperties: z.literal(false),
    })
    .strict(),
);

/** One node of a plugin's configSchema tree.
 *
 * Uses `z.union` rather than `z.discriminatedUnion`: under this repo's
 * `exactOptionalPropertyTypes: true` (tsconfig.base.json), a
 * `discriminatedUnion` nested inside a recursive `z.lazy` produces a zod4
 * internal type error (`$ZodTypeDiscriminable`'s `propValues` field) that
 * is a typing-only artifact, not a validation difference — every member
 * here already carries its own `type` literal, so `z.union`'s ordinary
 * try-each-variant matching validates identically; it only loses
 * discriminatedUnion's faster dispatch and slightly less specific error
 * messages, neither of which this recursive tree is performance- or
 * error-message-sensitive about. */
export const LppConfigFieldSchema: z.ZodType<LppConfigFieldNode> = z.lazy(() =>
  z.union([
    LppConfigStringFieldSchema,
    LppConfigNumberFieldSchema,
    LppConfigBooleanFieldSchema,
    LppConfigArrayFieldSchema,
    LppConfigObjectFieldSchema,
  ]),
);

/**
 * The manifest's whole `configSchema` value: always a top-level object
 * (C2 — the admin form renders one form per plugin from one root schema).
 * A plugin with no configurable fields still returns this shape with an
 * empty `properties` object — `configSchema` is never absent (see
 * envelope.ts).
 */
export const LppConfigSchema = LppConfigObjectFieldSchema;

export type LppConfig = LppConfigObjectField;

/** The canonical empty configSchema for a plugin with no configurable fields. */
export const LPP_EMPTY_CONFIG_SCHEMA: LppConfig = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Validates the C3 constraint that `secret: true` is only legal on a
 * `type: "string"` leaf — LppConfigStringFieldSchema is the only field
 * schema with a `secret` keyword at all, so this only needs to walk the
 * tree checking for fields the header encoding (headers.ts) could not
 * represent. Returns the dotted paths of every violation (empty = valid).
 */
export function findSecretOnNonStringFields(schema: LppConfig, pathPrefix = ""): string[] {
  const violations: string[] = [];
  for (const [key, field] of Object.entries(schema.properties)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (field.type !== "string" && "secret" in field && (field as { secret?: boolean }).secret) {
      violations.push(path);
    }
    if (field.type === "object") {
      violations.push(...findSecretOnNonStringFields(field, path));
    }
    if (field.type === "array" && field.items.type === "object") {
      violations.push(...findSecretOnNonStringFields(field.items, `${path}[]`));
    }
  }
  return violations;
}

/** Field keys marked `secret: true` at the top level of a configSchema —
 *  these are the names a plugin's config MUST resolve via
 *  `X-LPP-Secret-<NAME>` rather than `X-LPP-Config` (headers.ts). */
export function listTopLevelSecretFieldNames(schema: LppConfig): string[] {
  return Object.entries(schema.properties)
    .filter(([, field]) => field.type === "string" && field.secret === true)
    .map(([key]) => key);
}

// ============================================================================
// H-1 fix wave: `secret: true` is legal ONLY at the root (a top-level
// configSchema property) — see envelope.ts's staged parser, which is the
// ONLY place this is enforced (a frozen-contract narrowing, D23 pre-release
// policy). The header encoding (headers.ts) has no representation for a
// secret nested inside `X-LPP-Config`'s JSON object — every consumer
// (plugin-config.ts, the admin form renderer, the outbox payload builder)
// already only ever resolves secret-ness via `listTopLevelSecretFieldNames`
// above, so a nested `secret: true` was previously schema-legal but
// silently treated as a plain (non-secret) value everywhere — this function
// makes that shape a REJECTED manifest instead of a silent plaintext leak.
// Deliberately NOT folded into `LppConfigSchema` itself (matching the
// established "unknown capability type" precedent, C2 — the raw zod schema
// stays permissive, the STAGED parser is where the frozen-contract rule
// lives), so a directly-constructed `LppConfig` value (fixtures, the raw
// JSON Schema artifact) is unaffected; only `parseLppManifest` rejects it.
// ============================================================================

/**
 * Dotted/bracketed paths of every `secret: true` STRING field found at any
 * depth greater than 1 (i.e. NOT a direct top-level `configSchema.properties`
 * entry) — nested inside an `object`'s `properties` or an `array`'s `items`,
 * at any depth. Empty = valid (every secret marker, if any, is top-level).
 */
export function findSecretBelowRoot(schema: LppConfig): string[] {
  const violations: string[] = [];

  function walk(node: LppConfigFieldNode, path: string): void {
    if (node.type === "string") {
      if (node.secret === true) violations.push(path);
      return;
    }
    if (node.type === "object") {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (node.type === "array") {
      walk(node.items, `${path}[]`);
    }
  }

  for (const [key, field] of Object.entries(schema.properties)) {
    // The root's OWN direct properties are exactly the fields
    // `listTopLevelSecretFieldNames` above already treats as legally
    // secret-eligible — walk their CHILDREN only (never the root field
    // itself, even when it is itself a string).
    if (field.type === "object") {
      for (const [childKey, child] of Object.entries(field.properties)) {
        walk(child, `${key}.${childKey}`);
      }
    } else if (field.type === "array") {
      walk(field.items, `${key}[]`);
    }
  }

  return violations;
}

// ============================================================================
// M-2 fix wave: bound configSchema recursion depth + enum/properties/required
// cardinality BEFORE zod ever sees the tree (frozen-contract narrowing, D23).
// `LppConfigFieldSchema` is a `z.lazy` recursive union with no depth bound of
// its own — a sufficiently deep (but otherwise tiny, well under
// LPP_MANIFEST_MAX_BYTES) configSchema exhausts the JS call stack inside
// zod's own recursive validation (`RangeError: Maximum call stack size
// exceeded`), which `safeParse` does NOT catch (it only catches validation
// failures, not stack exhaustion) — this walker runs on the RAW, untyped
// value first, and its own recursion is bounded to `MAX_CONFIG_SCHEMA_DEPTH`
// stack frames REGARDLESS of how deep the malicious input actually goes
// (it bails out the instant the bound is exceeded, never recursing further
// into the offending branch), so it can never itself overflow the stack.
// ============================================================================

/** ~8 levels is generous for the settings-registry vocabulary this mirrors
 *  (json-schema-subset.ts's file header) — no legitimate plugin config form
 *  needs deeper nesting than this. */
export const MAX_CONFIG_SCHEMA_DEPTH = 8;
/** Per-node cap on `enum` array length — a 20 000-entry enum is schema-legal
 *  today and would render as 20 000 segmented-control buttons. */
export const MAX_CONFIG_SCHEMA_ENUM_LENGTH = 200;
/** Per-object-node cap on `properties` key count. */
export const MAX_CONFIG_SCHEMA_PROPERTIES = 200;
/** Per-object-node cap on `required` array length. */
export const MAX_CONFIG_SCHEMA_REQUIRED_LENGTH = 200;

export type ConfigSchemaBoundsViolationReason =
  | "max-depth-exceeded"
  | "too-many-properties"
  | "enum-too-large"
  | "too-many-required";

export interface ConfigSchemaBoundsViolation {
  path: string;
  reason: ConfigSchemaBoundsViolationReason;
}

/**
 * Walks a RAW (untyped, not-yet-zod-validated) `configSchema` value,
 * returning the first structural-bound violation found (depth-first,
 * deterministic), or `null` if the whole tree is within bounds. Defensive
 * about shape: anything that isn't a plain object is simply not a bound
 * violation at this level (zod's own type validation reports the real shape
 * error) — this function's only job is to guarantee ITS OWN recursion can
 * never exceed `MAX_CONFIG_SCHEMA_DEPTH` frames, so it must never recurse
 * based on unvalidated assumptions about `raw`'s shape.
 */
export function checkConfigSchemaBounds(raw: unknown, path = "", depth = 1): ConfigSchemaBoundsViolation | null {
  if (depth > MAX_CONFIG_SCHEMA_DEPTH) {
    return { path, reason: "max-depth-exceeded" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const node = raw as Record<string, unknown>;

  if (node.type === "string" && Array.isArray(node.enum) && node.enum.length > MAX_CONFIG_SCHEMA_ENUM_LENGTH) {
    return { path: path ? `${path}.enum` : "enum", reason: "enum-too-large" };
  }

  if (node.type === "object") {
    const properties = node.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      const propEntries = Object.entries(properties as Record<string, unknown>);
      if (propEntries.length > MAX_CONFIG_SCHEMA_PROPERTIES) {
        return { path: path ? `${path}.properties` : "properties", reason: "too-many-properties" };
      }
      for (const [key, value] of propEntries) {
        const violation = checkConfigSchemaBounds(value, path ? `${path}.${key}` : key, depth + 1);
        if (violation) return violation;
      }
    }
    if (Array.isArray(node.required) && node.required.length > MAX_CONFIG_SCHEMA_REQUIRED_LENGTH) {
      return { path: path ? `${path}.required` : "required", reason: "too-many-required" };
    }
    return null;
  }

  if (node.type === "array" && node.items !== undefined) {
    return checkConfigSchemaBounds(node.items, `${path}[]`, depth + 1);
  }

  return null;
}
