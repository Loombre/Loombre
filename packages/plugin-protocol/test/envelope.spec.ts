// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/envelope.spec.ts

import { describe, expect, it } from "vitest";
import { LppManifestSchema, describeLppManifestParseFailure, parseLppManifest } from "../src/envelope.js";
import { manifestFixture, secretConfigSchemaFixture, eventSubscriberCapabilityFixture, metadataProviderCapabilityFixture } from "./fixtures.js";

describe("LppManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    const result = LppManifestSchema.safeParse(manifestFixture());
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues)).toBe(true);
  });

  it("accepts a manifest with an event-subscriber capability and a secret config field", () => {
    const manifest = manifestFixture({
      capabilities: [eventSubscriberCapabilityFixture()],
      configSchema: secretConfigSchemaFixture(),
    });
    const result = LppManifestSchema.safeParse(manifest);
    expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues)).toBe(true);
  });

  it("rejects a manifest with an unknown top-level field (strict envelope)", () => {
    const manifest = { ...manifestFixture(), extra: "nope" };
    expect(LppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects an empty capabilities array", () => {
    const manifest = manifestFixture({ capabilities: [] });
    expect(LppManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("parseLppManifest", () => {
  it("returns ok:true with a typed manifest for well-formed input", () => {
    const result = parseLppManifest(manifestFixture());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.protocolVersion).toBe(1);
      expect(result.manifest.capabilities).toHaveLength(1);
    }
  });

  it("reports stage 'envelope' for a structurally malformed manifest", () => {
    const result = parseLppManifest({ name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("envelope");
  });

  it("reports stage 'protocol-version' with the offending value for an unsupported protocolVersion", () => {
    const result = parseLppManifest(manifestFixture({ protocolVersion: 2 as 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "protocol-version") {
      expect(result.found).toBe(2);
    } else {
      throw new Error(`expected stage 'protocol-version', got ${JSON.stringify(result)}`);
    }
  });

  it("reports stage 'capabilities' with unknownTypes for a capability type it does not recognize — never silently ignored", () => {
    const raw = {
      ...manifestFixture(),
      capabilities: [{ type: "future-capability-x", someField: true }],
    };
    const result = parseLppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "capabilities") {
      expect(result.unknownTypes).toEqual(["future-capability-x"]);
    } else {
      throw new Error(`expected stage 'capabilities', got ${JSON.stringify(result)}`);
    }
  });

  it("reports stage 'capabilities' distinctly for a known type with malformed fields (not unknown-type)", () => {
    const raw = {
      ...manifestFixture(),
      capabilities: [{ type: "metadata-provider", mediaKinds: [], contentClass: "general", endpoints: {} }],
    };
    const result = parseLppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "capabilities") {
      expect(result.unknownTypes).toEqual([]);
      expect(result.results.some((r) => !r.ok && r.reason === "invalid-capability")).toBe(true);
    } else {
      throw new Error(`expected stage 'capabilities', got ${JSON.stringify(result)}`);
    }
  });

  it("a manifest with one unknown and one valid capability still reports the valid one in results", () => {
    const raw = {
      ...manifestFixture(),
      capabilities: [eventSubscriberCapabilityFixture(), { type: "not-a-real-type" }],
    };
    const result = parseLppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "capabilities") {
      expect(result.unknownTypes).toEqual(["not-a-real-type"]);
      expect(result.results[0]?.ok).toBe(true);
      expect(result.results[1]?.ok).toBe(false);
    } else {
      throw new Error(`expected stage 'capabilities', got ${JSON.stringify(result)}`);
    }
  });

  it("reports stage 'config-schema' for a configSchema outside the supported subset", () => {
    const raw = { ...manifestFixture(), configSchema: { type: "object", properties: {}, additionalProperties: true } };
    const result = parseLppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("config-schema");
  });

  it("describeLppManifestParseFailure produces a non-empty, clear message for every failure stage", () => {
    const failures = [
      parseLppManifest({ name: "x" }),
      parseLppManifest(manifestFixture({ protocolVersion: 2 as 1 })),
      parseLppManifest({ ...manifestFixture(), capabilities: [{ type: "unknown-type" }] }),
      parseLppManifest({ ...manifestFixture(), configSchema: { type: "object", properties: {}, additionalProperties: true } }),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const message = describeLppManifestParseFailure(result);
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });

  it("the unknown-capability-type message names the exact offending type ('this Loombre doesn't support X yet')", () => {
    const result = parseLppManifest({ ...manifestFixture(), capabilities: [{ type: "totally-unknown" }] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "capabilities") {
      const message = describeLppManifestParseFailure(result);
      expect(message).toContain("totally-unknown");
      expect(message.toLowerCase()).toContain("doesn't support");
    }
  });

  // C-1 fix wave regression test — the exact probe4.mjs scenario the
  // adversarial review used: two `metadata-provider` entries, the SECOND
  // one carrying a `contentClass` the first doesn't. Before this fix,
  // nothing rejected this manifest at parse time — `manifest-diff.ts`'s
  // `.find()` and `computeAggregateContentClass`'s `.some()` disagreed on
  // "the" entry of this type, letting a plugin silently widen from
  // general to restricted with zero admin decision (C4/C5 bypass).
  describe("C-1 fix wave: duplicate capability types are rejected at parse", () => {
    it("rejects a manifest with two metadata-provider entries", () => {
      const first = metadataProviderCapabilityFixture();
      const second = { ...metadataProviderCapabilityFixture(), contentClass: "restricted" as const };
      const result = parseLppManifest(manifestFixture({ capabilities: [first, second] }));
      expect(result.ok).toBe(false);
      if (!result.ok && result.stage === "capabilities") {
        expect(result.duplicateTypes).toEqual(["metadata-provider"]);
        expect(result.unknownTypes).toEqual([]);
      } else {
        throw new Error(`expected stage 'capabilities', got ${JSON.stringify(result)}`);
      }
    });

    it("rejects a manifest with two event-subscriber entries", () => {
      const first = eventSubscriberCapabilityFixture();
      const second = { ...eventSubscriberCapabilityFixture(), contentClass: "restricted" as const };
      const result = parseLppManifest(manifestFixture({ capabilities: [first, second] }));
      expect(result.ok).toBe(false);
      if (!result.ok && result.stage === "capabilities") {
        expect(result.duplicateTypes).toEqual(["event-subscriber"]);
      } else {
        throw new Error(`expected stage 'capabilities', got ${JSON.stringify(result)}`);
      }
    });

    it("the duplicate-type message names the offending type and explains the 'at most one entry' rule", () => {
      const first = metadataProviderCapabilityFixture();
      const second = metadataProviderCapabilityFixture();
      const result = parseLppManifest(manifestFixture({ capabilities: [first, second] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const message = describeLppManifestParseFailure(result);
        expect(message).toContain("metadata-provider");
        expect(message).toContain("more than once");
      }
    });

    it("one of each type (no duplicates) is accepted", () => {
      const result = parseLppManifest(
        manifestFixture({ capabilities: [metadataProviderCapabilityFixture(), eventSubscriberCapabilityFixture()] }),
      );
      expect(result.ok).toBe(true);
    });
  });

  // H-1 fix wave regression test — `secret: true` is schema-legal at any
  // depth (json-schema-subset.ts's LppConfigStringFieldSchema), but only a
  // TOP-LEVEL configSchema property is ever actually routed to the
  // keyring by any consumer (plugin-config.ts's validatePluginConfig) —
  // a nested marker was previously silently treated as plain, non-secret
  // data (DB, API, UI, and the plugin.updated outbox event, per H-1).
  describe("H-1 fix wave: secret:true below the configSchema root is rejected at parse", () => {
    it("rejects a secret marker nested inside an object field", () => {
      const raw = {
        ...manifestFixture(),
        configSchema: {
          type: "object",
          properties: {
            creds: {
              type: "object",
              properties: { apiKey: { type: "string", secret: true } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      };
      const result = parseLppManifest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok && result.stage === "config-schema-secret-placement") {
        expect(result.paths).toEqual(["creds.apiKey"]);
      } else {
        throw new Error(`expected stage 'config-schema-secret-placement', got ${JSON.stringify(result)}`);
      }
    });

    it("rejects a secret marker nested inside an array's items", () => {
      const raw = {
        ...manifestFixture(),
        configSchema: {
          type: "object",
          properties: {
            keys: { type: "array", items: { type: "string", secret: true } },
          },
          additionalProperties: false,
        },
      };
      const result = parseLppManifest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok && result.stage === "config-schema-secret-placement") {
        expect(result.paths).toEqual(["keys[]"]);
      } else {
        throw new Error(`expected stage 'config-schema-secret-placement', got ${JSON.stringify(result)}`);
      }
    });

    it("a TOP-LEVEL secret:true field is still accepted (unaffected by the narrowing)", () => {
      const result = parseLppManifest(manifestFixture({ configSchema: secretConfigSchemaFixture() }));
      expect(result.ok).toBe(true);
    });
  });

  // M-2 fix wave regression test — the exact probe3.mjs scenario: a
  // depth-1000 configSchema (well under LPP_MANIFEST_MAX_BYTES) used to
  // raise `RangeError: Maximum call stack size exceeded` out of
  // parseLppManifest, escaping as an untyped 500 instead of a typed 422.
  describe("M-2 fix wave: configSchema structural bounds", () => {
    function deeplyNestedConfigSchema(depth: number): Record<string, unknown> {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < depth; i++) {
        node = { type: "object", properties: { nested: node }, additionalProperties: false };
      }
      return node;
    }

    it("a depth-1000 configSchema is rejected as a typed failure, never a RangeError", () => {
      const raw = { ...manifestFixture(), configSchema: deeplyNestedConfigSchema(1000) };
      expect(() => parseLppManifest(raw)).not.toThrow();
      const result = parseLppManifest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe("config-schema-bounds");
      }
    });

    it("a reasonably-nested configSchema (well under the depth bound) is still accepted", () => {
      const raw = { ...manifestFixture(), configSchema: deeplyNestedConfigSchema(3) };
      const result = parseLppManifest(raw);
      expect(result.ok, JSON.stringify(!result.ok ? result : undefined)).toBe(true);
    });

    it("a 20000-entry enum is rejected as a typed failure", () => {
      const raw = {
        ...manifestFixture(),
        configSchema: {
          type: "object",
          properties: { mode: { type: "string", enum: Array.from({ length: 20_000 }, (_, i) => `option-${i}`) } },
          additionalProperties: false,
        },
      };
      const result = parseLppManifest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.stage).toBe("config-schema-bounds");
      }
    });

    it("a reasonable enum (well under the bound) is still accepted", () => {
      const raw = {
        ...manifestFixture(),
        configSchema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["off", "on", "auto"] } },
          additionalProperties: false,
        },
      };
      expect(parseLppManifest(raw).ok).toBe(true);
    });
  });
});
