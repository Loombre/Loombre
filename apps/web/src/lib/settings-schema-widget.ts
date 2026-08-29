// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/settings-schema-widget.ts
//
// STATE.md Addendum A, decision A6/A7 (lane S2): the pure decision logic
// behind the admin settings page's schema-driven renderer — GET
// /admin/settings/schema's `valueSchema` (AD3: z.toJSONSchema(entry.schema)
// from packages/shared/src/settings-registry.ts, the SAME projection the
// generated docs use) is the ONLY thing this module reads to decide which
// widget a key gets. Nobody hand-writes a per-key form anywhere in
// apps/web — apps/admin/settings/page.tsx and its child components walk
// GET /admin/settings/schema's entries and call resolveWidgetKind() per
// entry; there is no switch-on-key-name anywhere in this surface.
//
// Kept framework-free and pure (no React) so it's unit-testable in
// isolation, matching this codebase's established pattern (grid-
// windowing.ts, playback-reasons.ts, admin-jobs-live.ts, ...).
//
// validateAgainstJsonSchema is a small, hand-rolled JSON-Schema-SUBSET
// validator — not a general-purpose validator (ajv is a devDependency of
// this package, test-only; shipping it into a real admin page bundle would
// promote a test-time dependency into production code, which this lane
// avoids rather than editing package.json / running an install). It covers
// exactly the keyword vocabulary z.toJSONSchema (AD3) actually emits for
// this registry's schemas — verified against every SettingsRegistryEntry
// in packages/shared/src/settings-registry.ts: type/enum/minimum/maximum/
// minLength/minItems/items/properties/required/additionalProperties. This
// is what backs A7's client-side validation (including the
// restricted.majorityAgeYears >=18 floor — that floor is simply this
// entry's schema.minimum, so no key-specific code is needed for it either)
// AND the "structured" (array/object) widget's JSON-aware editor.

export type SettingsWidgetKind = "boolean" | "number" | "enum" | "string" | "structured";

export type JsonSchemaLike = Record<string, unknown>;

export interface NumberConstraints {
  min?: number;
  max?: number;
  integer: boolean;
}

/** z.number().int() with no .max() call projects a literal
 *  Number.MAX_SAFE_INTEGER maximum (verified directly against
 *  packages/shared's zod install) — that's "no real ceiling", not an
 *  actual business rule to render/enforce in the UI. */
const UNBOUNDED_MAX_SENTINEL = Number.MAX_SAFE_INTEGER;

/** Chooses the widget a key's `valueSchema` gets. Enum wins over a bare
 *  `type` check (z.enum(...) projects `{ type: 'string', enum: [...] }` —
 *  without this ordering every enum would render as a plain text input). */
export function resolveWidgetKind(schema: JsonSchemaLike): SettingsWidgetKind {
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((v) => typeof v === "string")) {
    return "enum";
  }
  switch (schema["type"]) {
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      // array/object/anything this module doesn't specifically recognize —
      // the structured, JSON-aware editor is the honest fallback rather
      // than guessing at a scalar control that can't represent the value.
      return "structured";
  }
}

export function numberConstraints(schema: JsonSchemaLike): NumberConstraints {
  const min = typeof schema["minimum"] === "number" ? (schema["minimum"] as number) : undefined;
  const rawMax = typeof schema["maximum"] === "number" ? (schema["maximum"] as number) : undefined;
  const max = rawMax !== undefined && rawMax < UNBOUNDED_MAX_SENTINEL ? rawMax : undefined;
  // exactOptionalPropertyTypes: build the object with keys only present
  // when there IS a value — an explicit `min: undefined` is a type error
  // under this tsconfig, distinct from the key being absent entirely.
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    integer: schema["type"] === "integer",
  };
}

export function enumOptions(schema: JsonSchemaLike): string[] {
  const values = schema["enum"];
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Client-side schema validation (A7): the SAME projected JSON Schema every
 * widget renders from is what refuses an invalid draft before it's ever
 * submitted. Returns the first violation found (a short, field-appropriate
 * message) or null when `value` satisfies `schema`. Recurses into
 * array items / object properties for the "structured" widget.
 *
 * This is deliberately NOT a general-purpose validator (see this file's
 * header) — it accepts anything it doesn't recognize (an unhandled schema
 * shape never blocks a submit; the server's own 422 is always the backstop,
 * per A7's "server refuses too — surface its 422 cleanly").
 */
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchemaLike): string | null {
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.includes(value) ? null : `Must be one of ${enumValues.map((v) => JSON.stringify(v)).join(", ")}.`;
  }

  switch (schema["type"]) {
    case "boolean":
      return typeof value === "boolean" ? null : "Must be true or false.";

    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a number.";
      if (schema["type"] === "integer" && !Number.isInteger(value)) return "Must be a whole number.";
      const min = schema["minimum"];
      const max = schema["maximum"];
      if (typeof min === "number" && value < min) return `Must be at least ${min}.`;
      if (typeof max === "number" && value > max) return `Must be at most ${max}.`;
      return null;
    }

    case "string": {
      if (typeof value !== "string") return "Must be text.";
      const minLength = schema["minLength"];
      if (typeof minLength === "number" && value.length < minLength) {
        return `Must be at least ${minLength} character${minLength === 1 ? "" : "s"} long.`;
      }
      return null;
    }

    case "array": {
      if (!Array.isArray(value)) return "Must be a list.";
      const minItems = schema["minItems"];
      if (typeof minItems === "number" && value.length < minItems) {
        return `Must have at least ${minItems} item${minItems === 1 ? "" : "s"}.`;
      }
      const items = schema["items"];
      if (items !== undefined && typeof items === "object" && items !== null) {
        for (let i = 0; i < value.length; i += 1) {
          const itemError = validateAgainstJsonSchema(value[i], items as JsonSchemaLike);
          if (itemError) return `Item ${i + 1}: ${itemError}`;
        }
      }
      return null;
    }

    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return "Must be an object.";
      const record = value as Record<string, unknown>;
      const properties = (schema["properties"] as Record<string, JsonSchemaLike> | undefined) ?? {};
      const required = (schema["required"] as string[] | undefined) ?? [];
      for (const key of required) {
        if (!(key in record)) return `Missing required field "${key}".`;
      }
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in record) {
          const propError = validateAgainstJsonSchema(record[key], propSchema);
          if (propError) return `"${key}": ${propError}`;
        }
      }
      if (schema["additionalProperties"] === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) return `Unexpected field "${key}".`;
        }
      }
      return null;
    }

    default:
      return null;
  }
}

/** Stable-enough equality for UI display purposes (enabling/labeling a
 *  "reset to default" control) — NOT used for anything security-relevant;
 *  the server is always the authority on whether a write actually applies. */
export function isAtDefault(value: unknown, defaultValue: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(defaultValue);
}

export interface CategoryGroup<T> {
  category: string;
  entries: T[];
}

/** Groups entries by `category`, preserving first-seen order (the registry
 *  array's own order — SETTINGS_REGISTRY is itself grouped by category
 *  already, so this reproduces that grouping instead of alphabetizing it
 *  or otherwise re-deriving a second ordering rule). */
export function groupByCategory<T extends { category: string }>(entries: readonly T[]): CategoryGroup<T>[] {
  const order: string[] = [];
  const byCategory = new Map<string, T[]>();
  for (const entry of entries) {
    let bucket = byCategory.get(entry.category);
    if (!bucket) {
      bucket = [];
      byCategory.set(entry.category, bucket);
      order.push(entry.category);
    }
    bucket.push(entry);
  }
  return order.map((category) => ({ category, entries: byCategory.get(category)! }));
}

/** Phosphor registry filter (README "Interactions & behavior → Registry
 *  editing", STATE.md L6 scope item 3): case-insensitive substring match
 *  against the key and its description — the SAME two fields the prototype
 *  filters against (`e.k.toLowerCase().includes(regQ) ||
 *  e.desc.toLowerCase().includes(regQ)`). An empty/whitespace-only query
 *  matches everything (the "no filter applied" state). */
export function matchesRegistryQuery(entry: { key: string; description: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return entry.key.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
}

/** Filters a full entry list down to the ones `matchesRegistryQuery`,
 *  preserving order. Used for the cross-category "filter results" view —
 *  when a query is active, it searches every category at once rather than
 *  the currently selected one (matching the prototype's regList behavior:
 *  query presence overrides category scoping, never combines with it). */
export function filterEntriesByQuery<T extends { key: string; description: string }>(
  entries: readonly T[],
  query: string,
): T[] {
  return entries.filter((entry) => matchesRegistryQuery(entry, query));
}

export interface RegistryCategorySummary {
  category: string;
  /** Count of ALL entries in this category (not just UI-editable ones) —
   *  the pill's own derived count (README scope item 3: "category pills
   *  with counts (derived)"), never a value stored/duplicated anywhere
   *  else (STATE.md U9: user/restricted counts are the cautionary
   *  precedent for "derived, not stored"). */
  count: number;
  /** LD-9 (owner screenshot, Settings > Advanced Server): true when the
   *  category contains AT LEAST ONE scope:'env-only' key — drives the
   *  pill's padlock glyph. Previously this required EVERY entry in the
   *  category to be env-only (`es.every(...)`, mirroring a misread of the
   *  prototype's `entries.every(e => e.envOnly)`), which meant a MIXED
   *  category — one holding both an env-only key and a UI-editable one,
   *  e.g. "network" (http.port/network.corsOrigins are env-only;
   *  network.publicUrl/network.trustProxy are ui-scope) — never got the
   *  padlock at all, even though it genuinely has environment-pinned,
   *  never-editable-here keys inside it. The lock's honest meaning is "this
   *  category has at least one key you cannot edit through this surface no
   *  matter what" — `some`, not `every`. */
  hasEnvOnlyKey: boolean;
}

/** One summary row per category, in registry (first-seen) order. Pure
 *  projection over groupByCategory, so this order and the category-section
 *  order can never drift apart. HISTORY: LD-10 (owner screenshot) once
 *  locked an alphabetical-by-label sort for the category filter CHIPS,
 *  applied by RegistryFilterBar.tsx — that surface was deleted by the
 *  UIFIX-2026-08-29 Advanced rework (commit bcb64bb), whose category rail
 *  deliberately uses registry runtime order instead (DISCOVERY §6 / UD-20;
 *  supersession recorded in reports/state/DECISIONS.md at run close). No
 *  alphabetical consumer of this function remains. */
export function categorySummaries<T extends { category: string; scope: string }>(
  entries: readonly T[],
): RegistryCategorySummary[] {
  return groupByCategory(entries).map(({ category, entries: es }) => ({
    category,
    count: es.length,
    hasEnvOnlyKey: es.some((e) => e.scope === "env-only"),
  }));
}

export interface LockableEntry {
  scope: "ui" | "env-only";
  envVar?: string;
  locked: boolean;
  lockedBy?: string;
}

/**
 * A8's two DISTINCT locked shapes, spelled out as display copy (not just a
 * boolean) so the UI can render "why is this read-only" instead of a bare
 * disabled control:
 *   - scope:'env-only' — never editable through this surface at all,
 *     regardless of whether the env var happens to be set right now.
 *   - scope:'ui' + locked:true — an ACTIVE env pin; editable in principle,
 *     inert until the operator unsets the env var and restarts.
 * Returns null for an ordinary editable key (not locked either way).
 */
export function describeLocked(entry: LockableEntry): string | null {
  if (entry.scope === "env-only") {
    return entry.envVar
      ? `Set by environment (${entry.envVar}). Env-only setting — never editable here.`
      : "Env-only setting — never editable here.";
  }
  if (entry.locked) {
    return entry.lockedBy
      ? `Set by environment (${entry.lockedBy}). Remove it from the environment and restart to edit here.`
      : "Set by environment. Remove the pin and restart to edit here.";
  }
  return null;
}

/** Presentation-only formatting for a value/default display (never fed back
 *  into a request body — the structured widget's editable draft is its own
 *  JSON.stringify(value, null, 2), formatted separately at the call site so
 *  it can stay a controlled textarea value). Primitives render as-is
 *  (String()), arrays/objects as compact JSON — long enough to recognize,
 *  short enough not to blow out a summary row. */
export function formatSettingValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when a source's `value` even has an editable widget path at all —
 *  scope:'env-only' entries are read-only ALWAYS (A8), independent of
 *  `locked` (which only ever applies to scope:'ui'). Both editable and
 *  read-only widgets exist for the SAME key over time (a ui entry becomes
 *  temporarily locked when its env pin is set), so this is a per-render
 *  decision, not a static property of the key. */
export function isEditable(entry: LockableEntry): boolean {
  return entry.scope === "ui" && !entry.locked;
}
