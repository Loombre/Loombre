// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/json-schema-subset.spec.ts

import { describe, expect, it } from "vitest";
import {
  LPP_EMPTY_CONFIG_SCHEMA,
  LppConfigSchema,
  checkConfigSchemaBounds,
  findInconsistentDefaults,
  findSecretBelowRoot,
  listTopLevelSecretFieldNames,
  type LppConfig,
} from "../src/json-schema-subset.js";

describe("LppConfigSchema", () => {
  it("accepts the canonical empty configSchema", () => {
    expect(LppConfigSchema.safeParse(LPP_EMPTY_CONFIG_SCHEMA).success).toBe(true);
  });

  it("accepts a mix of string/number/boolean/enum/array/object fields, mirroring settings-registry conventions", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        webhookUrl: { type: "string", description: "Webhook URL", secret: true },
        maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        enabled: { type: "boolean", default: true },
        mode: { type: "string", enum: ["off", "on"] },
        tags: { type: "array", items: { type: "string" } },
        ladder: {
          type: "array",
          items: {
            type: "object",
            properties: { heightPx: { type: "integer" }, codec: { type: "string", enum: ["h264", "hevc"] } },
            additionalProperties: false,
          },
        },
      },
      required: ["webhookUrl"],
      additionalProperties: false,
    };
    const result = LppConfigSchema.safeParse(schema);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues)).toBe(true);
  });

  it("rejects a oneOf/anyOf shape (outside the supported subset)", () => {
    const schema = {
      type: "object",
      properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } },
      additionalProperties: false,
    };
    expect(LppConfigSchema.safeParse(schema).success).toBe(false);
  });

  it("rejects additionalProperties: true at the top level (must be a closed object)", () => {
    const schema = { type: "object", properties: {}, additionalProperties: true };
    expect(LppConfigSchema.safeParse(schema).success).toBe(false);
  });

  it("rejects an unrecognized field-level keyword (no invented widget vocabulary)", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string", widget: "color-picker" } },
      additionalProperties: false,
    };
    expect(LppConfigSchema.safeParse(schema).success).toBe(false);
  });
});

describe("H-1 fix wave: findSecretBelowRoot", () => {
  it("returns [] when the only secret markers are top-level", () => {
    const schema: LppConfig = {
      type: "object",
      properties: { apiKey: { type: "string", secret: true }, plain: { type: "string" } },
      additionalProperties: false,
    };
    expect(findSecretBelowRoot(schema)).toEqual([]);
  });

  it("flags a secret nested inside an object property, by dotted path", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        creds: { type: "object", properties: { token: { type: "string", secret: true } }, additionalProperties: false },
      },
      additionalProperties: false,
    };
    expect(findSecretBelowRoot(schema)).toEqual(["creds.token"]);
  });

  it("flags a secret nested inside an array's items", () => {
    const schema: LppConfig = {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string", secret: true } } },
      additionalProperties: false,
    };
    expect(findSecretBelowRoot(schema)).toEqual(["keys[]"]);
  });

  it("flags every violation, not just the first", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        a: { type: "object", properties: { x: { type: "string", secret: true } }, additionalProperties: false },
        b: { type: "array", items: { type: "string", secret: true } },
      },
      additionalProperties: false,
    };
    expect(findSecretBelowRoot(schema).sort()).toEqual(["a.x", "b[]"]);
  });

  it("returns [] for the canonical empty configSchema", () => {
    expect(findSecretBelowRoot(LPP_EMPTY_CONFIG_SCHEMA)).toEqual([]);
  });
});

describe("M-2 fix wave: checkConfigSchemaBounds", () => {
  it("returns null (in bounds) for a shallow, small schema", () => {
    expect(checkConfigSchemaBounds({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false })).toBeNull();
  });

  it("flags a schema exceeding the depth bound WITHOUT itself recursing arbitrarily deep", () => {
    // 1000 levels of object nesting — a naive recursive walker mirroring
    // the depth would also risk stack pressure; checkConfigSchemaBounds's
    // own recursion is bounded to MAX_CONFIG_SCHEMA_DEPTH+1 frames
    // regardless, which is the whole point (it must never itself become
    // the thing that overflows).
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 1000; i++) {
      node = { type: "object", properties: { nested: node }, additionalProperties: false };
    }
    const violation = checkConfigSchemaBounds(node);
    expect(violation).not.toBeNull();
    expect(violation?.reason).toBe("max-depth-exceeded");
  });

  it("flags an oversized enum", () => {
    const violation = checkConfigSchemaBounds({
      type: "object",
      properties: { mode: { type: "string", enum: Array.from({ length: 500 }, (_, i) => `o${i}`) } },
      additionalProperties: false,
    });
    expect(violation?.reason).toBe("enum-too-large");
  });

  it("flags too many properties on one object node", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) properties[`field${i}`] = { type: "string" };
    const violation = checkConfigSchemaBounds({ type: "object", properties, additionalProperties: false });
    expect(violation?.reason).toBe("too-many-properties");
  });

  it("is defensive about non-object input (returns null, defers to zod's own type validation)", () => {
    expect(checkConfigSchemaBounds("not a schema")).toBeNull();
    expect(checkConfigSchemaBounds(null)).toBeNull();
    expect(checkConfigSchemaBounds(42)).toBeNull();
  });

  // The walker's descent must be SHAPE-driven, not `type`-driven: zod
  // recurses on the `properties`/`items` KEYS regardless of whether the
  // node's `type` literal matched, so gating descent on a recognized
  // `type` would leave the whole subtree below any missing/typo'd `type`
  // unbounded — the exact DoS pre-check this function exists to provide.
  describe("descends regardless of a node's own `type`", () => {
    function deepChain(depth: number): Record<string, unknown> {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < depth; i++) {
        node = { type: "object", properties: { nested: node }, additionalProperties: false };
      }
      return node;
    }

    it("flags a deep chain whose ROOT `type` is typo'd", () => {
      const violation = checkConfigSchemaBounds({ ...deepChain(1000), type: "objectt" });
      expect(violation?.reason).toBe("max-depth-exceeded");
      expect(violation?.path).not.toBe("");
    });

    it("flags a deep chain whose ROOT `type` is absent", () => {
      const rootWithoutType = deepChain(1000);
      delete rootWithoutType.type;
      const violation = checkConfigSchemaBounds(rootWithoutType);
      expect(violation?.reason).toBe("max-depth-exceeded");
      expect(violation?.path).not.toBe("");
    });

    it("flags a deep chain whose `type` is typo'd at an INTERMEDIATE level", () => {
      // Typo three levels BELOW the root, i.e. well inside the depth bound —
      // everything under it must still be walked.
      const violation = checkConfigSchemaBounds({
        type: "object",
        properties: { a: { type: "object", properties: { b: { ...deepChain(1000), type: "objectt" } }, additionalProperties: false } },
        additionalProperties: false,
      });
      expect(violation?.reason).toBe("max-depth-exceeded");
      expect(violation?.path).not.toBe("");
    });

    it("flags a deep chain reached through an `items` key on a node with no `type`", () => {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 1000; i++) {
        node = { items: node };
      }
      const violation = checkConfigSchemaBounds(node);
      expect(violation?.reason).toBe("max-depth-exceeded");
    });
  });
});

describe("listTopLevelSecretFieldNames", () => {
  it("lists only top-level secret:true string fields", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        webhookUrl: { type: "string", secret: true },
        label: { type: "string" },
        retries: { type: "integer" },
      },
      additionalProperties: false,
    };
    expect(listTopLevelSecretFieldNames(schema)).toEqual(["webhookUrl"]);
  });

  it("returns [] for a schema with no secret fields", () => {
    expect(listTopLevelSecretFieldNames(LPP_EMPTY_CONFIG_SCHEMA)).toEqual([]);
  });
});

describe("findInconsistentDefaults", () => {
  it("returns [] when every default satisfies its own field's constraints", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "on"], default: "on" },
        label: { type: "string", minLength: 1, maxLength: 4, default: "abc" },
        pinned: { type: "string", const: "x", default: "x" },
        retries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        ratio: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        enabled: { type: "boolean", default: true },
      },
      additionalProperties: false,
    };
    expect(findInconsistentDefaults(schema)).toEqual([]);
  });

  it("returns [] for the canonical empty configSchema and for fields with no default", () => {
    expect(findInconsistentDefaults(LPP_EMPTY_CONFIG_SCHEMA)).toEqual([]);
    expect(findInconsistentDefaults({ type: "object", properties: { a: { type: "string", enum: ["x"] } }, additionalProperties: false })).toEqual([]);
  });

  it("flags a string default outside its own enum", () => {
    expect(findInconsistentDefaults({ type: "object", properties: { mode: { type: "string", enum: ["a", "b"], default: "c" } }, additionalProperties: false })).toEqual(["mode"]);
  });

  it("flags a string default disagreeing with const, or outside minLength/maxLength", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        pinned: { type: "string", const: "x", default: "y" },
        short: { type: "string", minLength: 3, default: "ab" },
        long: { type: "string", maxLength: 2, default: "abc" },
      },
      additionalProperties: false,
    };
    expect(findInconsistentDefaults(schema).sort()).toEqual(["long", "pinned", "short"]);
  });

  it("flags a numeric default outside minimum/maximum, and a non-integer default on an integer field", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        count: { type: "number", minimum: 10, maximum: 20, default: 999 },
        floor: { type: "number", minimum: 10, default: 1 },
        steps: { type: "integer", default: 1.5 },
      },
      additionalProperties: false,
    };
    expect(findInconsistentDefaults(schema).sort()).toEqual(["count", "floor", "steps"]);
  });

  it("reports nested paths inside objects and array items", () => {
    const schema: LppConfig = {
      type: "object",
      properties: {
        group: {
          type: "object",
          properties: { mode: { type: "string", enum: ["a"], default: "z" } },
          additionalProperties: false,
        },
        rungs: {
          type: "array",
          items: {
            type: "object",
            properties: { bitrate: { type: "integer", minimum: 100, default: 1 } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    };
    expect(findInconsistentDefaults(schema).sort()).toEqual(["group.mode", "rungs[].bitrate"]);
  });
});
