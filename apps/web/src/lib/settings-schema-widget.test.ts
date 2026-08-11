// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/settings-schema-widget.test.ts

import { describe, expect, it } from "vitest";
import {
  categorySummaries,
  describeLocked,
  enumOptions,
  filterEntriesByQuery,
  formatSettingValue,
  groupByCategory,
  isAtDefault,
  isEditable,
  matchesRegistryQuery,
  numberConstraints,
  resolveWidgetKind,
  validateAgainstJsonSchema,
  type JsonSchemaLike,
} from "./settings-schema-widget.js";

// Fixtures below are copied VERBATIM from real z.toJSONSchema() output
// against packages/shared/src/settings-registry.ts's own zod schemas
// (verified by hand at authoring time against a live `zod` install) —
// this module must decide correctly against the ACTUAL shapes the server
// projects, not an idealized JSON Schema.
const BOOLEAN_SCHEMA: JsonSchemaLike = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "boolean" };
const INT_MIN_ONLY_SCHEMA: JsonSchemaLike = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const MAJORITY_AGE_SCHEMA: JsonSchemaLike = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "integer",
  minimum: 18,
  maximum: Number.MAX_SAFE_INTEGER,
};
const QUALITY_SCHEMA: JsonSchemaLike = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "integer",
  minimum: 1,
  maximum: 100,
};
const ENUM_SCHEMA: JsonSchemaLike = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "string",
  enum: ["off", "manual", "acme"],
};
const STRING_SCHEMA: JsonSchemaLike = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" };
const LADDER_RUNG_SCHEMA: JsonSchemaLike = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  minItems: 1,
  type: "array",
  items: {
    type: "object",
    properties: {
      heightPx: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      videoBitrateBps: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      audioBitrateBps: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      // Tracks packages/shared's LADDER_RUNG_CODECS — av1 landed with LD-7
      // (Wave C1). This fixture claims to be verbatim z.toJSONSchema()
      // output, so it has to move when the registry's enum does.
      codec: { type: "string", enum: ["h264", "hevc", "av1"] },
    },
    required: ["heightPx", "videoBitrateBps", "audioBitrateBps", "codec"],
    additionalProperties: false,
  },
};

describe("resolveWidgetKind", () => {
  it("boolean schema -> boolean", () => {
    expect(resolveWidgetKind(BOOLEAN_SCHEMA)).toBe("boolean");
  });
  it("integer schema -> number", () => {
    expect(resolveWidgetKind(INT_MIN_ONLY_SCHEMA)).toBe("number");
  });
  it("string+enum schema -> enum (enum wins over the bare 'string' type)", () => {
    expect(resolveWidgetKind(ENUM_SCHEMA)).toBe("enum");
  });
  it("plain string schema -> string", () => {
    expect(resolveWidgetKind(STRING_SCHEMA)).toBe("string");
  });
  it("array schema (ladder rungs) -> structured", () => {
    expect(resolveWidgetKind(LADDER_RUNG_SCHEMA)).toBe("structured");
  });
  it("an unrecognized/absent type -> structured (honest fallback, never guesses a scalar)", () => {
    expect(resolveWidgetKind({})).toBe("structured");
  });
});

describe("numberConstraints", () => {
  it("extracts a real minimum and treats the MAX_SAFE_INTEGER sentinel as 'no max'", () => {
    expect(numberConstraints(INT_MIN_ONLY_SCHEMA)).toEqual({ min: 1, max: undefined, integer: true });
  });
  it("the restricted.majorityAgeYears floor (minimum: 18) round-trips exactly — this IS the client-side <18 refusal input", () => {
    expect(numberConstraints(MAJORITY_AGE_SCHEMA)).toEqual({ min: 18, max: undefined, integer: true });
  });
  it("extracts a real, finite maximum when the schema has one", () => {
    expect(numberConstraints(QUALITY_SCHEMA)).toEqual({ min: 1, max: 100, integer: true });
  });
});

describe("enumOptions", () => {
  it("returns the enum's string values in order", () => {
    expect(enumOptions(ENUM_SCHEMA)).toEqual(["off", "manual", "acme"]);
  });
  it("returns an empty array for a non-enum schema", () => {
    expect(enumOptions(STRING_SCHEMA)).toEqual([]);
  });
});

describe("validateAgainstJsonSchema — the A7 client-side floor", () => {
  it("accepts a valid boolean, rejects a non-boolean", () => {
    expect(validateAgainstJsonSchema(true, BOOLEAN_SCHEMA)).toBeNull();
    expect(validateAgainstJsonSchema("true", BOOLEAN_SCHEMA)).not.toBeNull();
  });

  it("accepts an in-range integer, rejects below the minimum", () => {
    expect(validateAgainstJsonSchema(5, INT_MIN_ONLY_SCHEMA)).toBeNull();
    expect(validateAgainstJsonSchema(0, INT_MIN_ONLY_SCHEMA)).toContain("at least 1");
  });

  it("rejects a non-integer number against an integer schema", () => {
    expect(validateAgainstJsonSchema(1.5, INT_MIN_ONLY_SCHEMA)).toContain("whole number");
  });

  it("refuses restricted.majorityAgeYears below 18 client-side (the mission's explicit <18 refusal), accepts 18 and above", () => {
    expect(validateAgainstJsonSchema(17, MAJORITY_AGE_SCHEMA)).toContain("at least 18");
    expect(validateAgainstJsonSchema(0, MAJORITY_AGE_SCHEMA)).toContain("at least 18");
    expect(validateAgainstJsonSchema(18, MAJORITY_AGE_SCHEMA)).toBeNull();
    expect(validateAgainstJsonSchema(99, MAJORITY_AGE_SCHEMA)).toBeNull();
  });

  it("rejects a value above the maximum", () => {
    expect(validateAgainstJsonSchema(150, QUALITY_SCHEMA)).toContain("at most 100");
  });

  it("enum: accepts a listed value, rejects an unlisted one with the option list in the message", () => {
    expect(validateAgainstJsonSchema("manual", ENUM_SCHEMA)).toBeNull();
    const error = validateAgainstJsonSchema("nightly", ENUM_SCHEMA);
    expect(error).toContain("off");
    expect(error).toContain("manual");
    expect(error).toContain("acme");
  });

  it("structured (ladder rungs): accepts a schema-valid array, rejects an empty array (minItems), rejects a bad item field", () => {
    const valid = [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" }];
    expect(validateAgainstJsonSchema(valid, LADDER_RUNG_SCHEMA)).toBeNull();
    expect(validateAgainstJsonSchema([], LADDER_RUNG_SCHEMA)).toContain("at least 1 item");
    // av1 became a legal rung codec with LD-7 (Wave C1) — this fixture
    // tracks the registry's real enum, so it must accept it too.
    const av1 = [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "av1" }];
    expect(validateAgainstJsonSchema(av1, LADDER_RUNG_SCHEMA)).toBeNull();

    // vp9 is a SOURCE codec, never an encode target — the enum's job is to
    // reject exactly this, and it is what the "bad item field" case needs
    // to be now that av1 is legal.
    const badCodec = [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "vp9" }];
    const error = validateAgainstJsonSchema(badCodec, LADDER_RUNG_SCHEMA);
    expect(error).toContain("Item 1");
    expect(error).toContain("codec");
  });

  it("structured: reports a missing required field by name", () => {
    const missingCodec = [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000 }];
    expect(validateAgainstJsonSchema(missingCodec, LADDER_RUNG_SCHEMA)).toContain('"codec"');
  });

  it("never blocks on a schema shape it doesn't recognize (server 422 is always the real backstop)", () => {
    expect(validateAgainstJsonSchema("anything", {})).toBeNull();
  });
});

describe("isAtDefault", () => {
  it("true for deep-equal primitives, arrays, and objects", () => {
    expect(isAtDefault(5, 5)).toBe(true);
    expect(isAtDefault([1, 2], [1, 2])).toBe(true);
    expect(isAtDefault({ a: 1 }, { a: 1 })).toBe(true);
  });
  it("false once the value diverges from the default", () => {
    expect(isAtDefault(5, 6)).toBe(false);
    expect(isAtDefault([1, 2], [1, 3])).toBe(false);
  });
});

describe("groupByCategory", () => {
  it("preserves first-seen category order and groups every entry with a matching category, without reordering within a category", () => {
    const entries = [
      { key: "a", category: "transcode" },
      { key: "b", category: "images" },
      { key: "c", category: "transcode" },
      { key: "d", category: "images" },
    ];
    const groups = groupByCategory(entries);
    expect(groups.map((g) => g.category)).toEqual(["transcode", "images"]);
    expect(groups[0]!.entries.map((e) => e.key)).toEqual(["a", "c"]);
    expect(groups[1]!.entries.map((e) => e.key)).toEqual(["b", "d"]);
  });
});

describe("matchesRegistryQuery / filterEntriesByQuery — Phosphor registry filter (README scope item 3)", () => {
  const entries = [
    { key: "transcode.maxSimultaneousTranscodes", description: "How many videos this server will convert at the same time." },
    { key: "rateLimit.login", description: "How many sign-in attempts one device may make per minute." },
    { key: "database.url", description: "PostgreSQL connection string." },
  ];

  it("an empty or whitespace-only query matches everything", () => {
    expect(matchesRegistryQuery(entries[0]!, "")).toBe(true);
    expect(matchesRegistryQuery(entries[0]!, "   ")).toBe(true);
    expect(filterEntriesByQuery(entries, "")).toEqual(entries);
  });

  it("matches case-insensitively against the key", () => {
    expect(matchesRegistryQuery(entries[0]!, "MAXSIMULTANEOUS")).toBe(true);
    expect(filterEntriesByQuery(entries, "ratelimit").map((e) => e.key)).toEqual(["rateLimit.login"]);
  });

  it("matches against the description when the key doesn't match", () => {
    expect(filterEntriesByQuery(entries, "sign-in").map((e) => e.key)).toEqual(["rateLimit.login"]);
  });

  it("returns an empty list when nothing matches, never throws", () => {
    expect(filterEntriesByQuery(entries, "nonexistent-zzz")).toEqual([]);
  });

  it("preserves original order across multiple matches", () => {
    expect(filterEntriesByQuery(entries, "e").map((e) => e.key)).toEqual([
      "transcode.maxSimultaneousTranscodes",
      "rateLimit.login",
      "database.url",
    ]);
  });
});

describe("categorySummaries — registry pill counts (derived, never stored)", () => {
  it("one summary row per category, in first-seen order, with a correct count", () => {
    const entries = [
      { key: "a", category: "transcode", scope: "ui" },
      { key: "b", category: "database", scope: "env-only" },
      { key: "c", category: "transcode", scope: "ui" },
    ];
    const summaries = categorySummaries(entries);
    expect(summaries).toEqual([
      { category: "transcode", count: 2, hasEnvOnlyKey: false },
      { category: "database", count: 1, hasEnvOnlyKey: true },
    ]);
  });

  // LD-9 (owner screenshot): the lock icon's condition is "at least one
  // env-only key", not "every key is env-only" — a MIXED category (like the
  // real registry's "network", which holds both env-only http.port/
  // network.corsOrigins and ui-scope network.publicUrl/network.trustProxy)
  // must still get the padlock, since it genuinely contains a key nobody
  // can edit through this surface.
  it("hasEnvOnlyKey is true once ANY entry in the category is scope:'env-only' — a mixed category (some env-only, some ui) still gets the lock", () => {
    const mixed = [
      { key: "a", category: "network", scope: "env-only" },
      { key: "b", category: "network", scope: "ui" },
    ];
    expect(categorySummaries(mixed)[0]!.hasEnvOnlyKey).toBe(true);
  });

  it("hasEnvOnlyKey is false when every entry in the category is scope:'ui' (no env-only key at all)", () => {
    const allUi = [
      { key: "a", category: "transcode", scope: "ui" },
      { key: "b", category: "transcode", scope: "ui" },
    ];
    expect(categorySummaries(allUi)[0]!.hasEnvOnlyKey).toBe(false);
  });

  it("an empty entry list produces no summaries", () => {
    expect(categorySummaries([])).toEqual([]);
  });
});

describe("formatSettingValue", () => {
  it("primitives render as-is", () => {
    expect(formatSettingValue(true)).toBe("true");
    expect(formatSettingValue(65)).toBe("65");
    expect(formatSettingValue("daily")).toBe("daily");
  });
  it("null/undefined get distinct, non-confusable renderings", () => {
    expect(formatSettingValue(null)).toBe("null");
    expect(formatSettingValue(undefined)).toBe("—");
  });
  it("empty string renders visibly quoted rather than disappearing", () => {
    expect(formatSettingValue("")).toBe('""');
  });
  it("arrays/objects render as compact JSON", () => {
    expect(formatSettingValue(["a", "b"])).toBe('["a","b"]');
    expect(formatSettingValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("describeLocked / isEditable — A8's two locked shapes", () => {
  it("env-only entries are never editable and always describe themselves as env-only, with or without a live env value", () => {
    const entry = { scope: "env-only" as const, envVar: "DATABASE_URL", locked: false };
    expect(isEditable(entry)).toBe(false);
    expect(describeLocked(entry)).toContain("DATABASE_URL");
    expect(describeLocked(entry)).toContain("Env-only");
  });

  it("a ui entry with an active env pin is not editable and names the pinning var", () => {
    const entry = { scope: "ui" as const, envVar: "LOOMBRE_RATE_LOGIN", locked: true, lockedBy: "LOOMBRE_RATE_LOGIN" };
    expect(isEditable(entry)).toBe(false);
    expect(describeLocked(entry)).toContain("LOOMBRE_RATE_LOGIN");
  });

  it("an ordinary ui entry with no pin is editable and has no lock description", () => {
    const entry = { scope: "ui" as const, locked: false };
    expect(isEditable(entry)).toBe(true);
    expect(describeLocked(entry)).toBeNull();
  });
});
