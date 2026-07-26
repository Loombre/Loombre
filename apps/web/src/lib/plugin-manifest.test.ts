// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-manifest.test.ts

import { describe, expect, it } from "vitest";
import {
  buildConfigSubmission,
  buildInitialConfigDraft,
  capabilityTypeLabel,
  describeCapabilityScope,
  describeEventSubscriberScope,
  describeMetadataProviderScope,
  describePluginStatus,
  isValidGrantSubset,
  pluginConfigSecretFieldNames,
  requestedEventTypes,
  resolvePluginFieldWidgetKind,
  validatePluginConfigDraft,
  type PluginCapability,
  type PluginConfigSchema,
} from "./plugin-manifest.js";

const METADATA_CAP: PluginCapability = { type: "metadata-provider", mediaKinds: ["movie", "tv"], contentClass: "general" };
const RESTRICTED_METADATA_CAP: PluginCapability = { type: "metadata-provider", mediaKinds: ["movie"], contentClass: "restricted" };
const EVENT_CAP: PluginCapability = { type: "event-subscriber", eventTypes: ["item.added", "playback.started"], contentClass: "general" };

describe("describeCapabilityScope / capabilityTypeLabel", () => {
  it("metadata-provider: names the media kinds and states it never sees viewer identity", () => {
    const line = describeMetadataProviderScope(METADATA_CAP as Extract<PluginCapability, { type: "metadata-provider" }>);
    expect(line).toContain("movies and TV shows");
    expect(line).toContain("never sees anything about who's watching or listening");
    expect(line).toContain("any library, restricted or not");
  });

  it("metadata-provider restricted scope: states it is confined to restricted libraries", () => {
    const line = describeMetadataProviderScope(RESTRICTED_METADATA_CAP as Extract<PluginCapability, { type: "metadata-provider" }>);
    expect(line).toContain("only ever sees restricted libraries");
  });

  it("event-subscriber: states it only receives granted activity, pseudonymous by default", () => {
    const line = describeEventSubscriberScope(EVENT_CAP as Extract<PluginCapability, { type: "event-subscriber" }>);
    expect(line).toContain("nothing more than what you grant below");
    expect(line).toContain("anonymous id, not a real account");
  });

  it("describeCapabilityScope dispatches on type", () => {
    expect(describeCapabilityScope(METADATA_CAP)).toBe(describeMetadataProviderScope(METADATA_CAP as never));
    expect(describeCapabilityScope(EVENT_CAP)).toBe(describeEventSubscriberScope(EVENT_CAP as never));
  });

  it("capabilityTypeLabel: known types get plain-language labels, unknown types pass through", () => {
    expect(capabilityTypeLabel("metadata-provider")).toBe("Metadata provider");
    expect(capabilityTypeLabel("event-subscriber")).toBe("Activity feed subscriber");
    expect(capabilityTypeLabel("subtitle-provider")).toBe("subtitle-provider");
  });
});

describe("describePluginStatus", () => {
  it("enabled + healthy -> success pill", () => {
    expect(describePluginStatus({ enabled: true, healthState: "healthy", disabledReason: null })).toEqual({
      label: "Enabled",
      tone: "success",
    });
  });

  it("enabled + unhealthy -> danger pill", () => {
    expect(describePluginStatus({ enabled: true, healthState: "unhealthy", disabledReason: null }).tone).toBe("danger");
  });

  it("enabled + unknown health -> info pill", () => {
    expect(describePluginStatus({ enabled: true, healthState: "unknown", disabledReason: null }).tone).toBe("info");
  });

  it("disabled by admin -> neutral pill", () => {
    expect(describePluginStatus({ enabled: false, healthState: "unknown", disabledReason: "admin" })).toEqual({
      label: "Disabled",
      tone: "neutral",
    });
  });

  it("disabled by breaker -> danger pill naming the reason", () => {
    const info = describePluginStatus({ enabled: false, healthState: "unhealthy", disabledReason: "breaker" });
    expect(info.tone).toBe("danger");
    expect(info.label).toContain("too many failures");
  });

  it("disabled by scope-change -> warning pill inviting re-approval", () => {
    const info = describePluginStatus({ enabled: false, healthState: "healthy", disabledReason: "scope-change" });
    expect(info.tone).toBe("warning");
    expect(info.label).toBe("Needs re-approval");
  });
});

const CONFIG_SCHEMA: PluginConfigSchema = {
  type: "object",
  properties: {
    fixturePrefix: { type: "string", default: "Loombre Fixture" },
    maxResults: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    webhookUrl: { type: "string", secret: true },
  },
  required: ["webhookUrl"],
};

describe("resolvePluginFieldWidgetKind", () => {
  it("a secret:true string field resolves to 'secret', overriding the ordinary string widget", () => {
    expect(resolvePluginFieldWidgetKind(CONFIG_SCHEMA.properties["webhookUrl"]!)).toBe("secret");
  });

  it("a plain string field resolves to 'string'", () => {
    expect(resolvePluginFieldWidgetKind(CONFIG_SCHEMA.properties["fixturePrefix"]!)).toBe("string");
  });

  it("an integer field resolves to 'number'", () => {
    expect(resolvePluginFieldWidgetKind(CONFIG_SCHEMA.properties["maxResults"]!)).toBe("number");
  });
});

describe("pluginConfigSecretFieldNames", () => {
  it("returns only the secret:true string field names", () => {
    expect(pluginConfigSecretFieldNames(CONFIG_SCHEMA)).toEqual(["webhookUrl"]);
  });
});

describe("buildInitialConfigDraft", () => {
  it("non-secret fields draft from current values when present", () => {
    const draft = buildInitialConfigDraft(CONFIG_SCHEMA, { fixturePrefix: "Existing", maxResults: 25 });
    expect(draft).toEqual({ fixturePrefix: "Existing", maxResults: 25 });
  });

  it("non-secret fields fall back to the schema default when no current value exists", () => {
    const draft = buildInitialConfigDraft(CONFIG_SCHEMA, {});
    expect(draft).toEqual({ fixturePrefix: "Loombre Fixture", maxResults: 10 });
  });

  it("secret fields are never included, even if somehow present in currentValues", () => {
    const draft = buildInitialConfigDraft(CONFIG_SCHEMA, { webhookUrl: "should-never-appear" });
    expect(draft).not.toHaveProperty("webhookUrl");
  });
});

describe("buildConfigSubmission", () => {
  it("includes a secret field only when the admin typed a non-empty replacement", () => {
    const withSecret = buildConfigSubmission(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 5 }, { webhookUrl: "https://example.invalid/hook" });
    expect(withSecret).toEqual({ fixturePrefix: "X", maxResults: 5, webhookUrl: "https://example.invalid/hook" });

    const withoutSecret = buildConfigSubmission(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 5 }, {});
    expect(withoutSecret).toEqual({ fixturePrefix: "X", maxResults: 5 });
    expect(withoutSecret).not.toHaveProperty("webhookUrl");
  });

  it("an explicit empty-string secret draft is treated as untouched, not as a value", () => {
    const submission = buildConfigSubmission(CONFIG_SCHEMA, {}, { webhookUrl: "" });
    expect(submission).not.toHaveProperty("webhookUrl");
  });
});

describe("validatePluginConfigDraft", () => {
  it("valid when every non-secret field satisfies its schema and required secrets are typed", () => {
    const result = validatePluginConfigDraft(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 5 }, { webhookUrl: "https://example.invalid" }, true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("a required blank secret fails when requireAllSecrets is true", () => {
    const result = validatePluginConfigDraft(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 5 }, {}, true);
    expect(result.valid).toBe(false);
    expect(result.errors["webhookUrl"]).toBeTruthy();
  });

  it("a required blank secret passes when requireAllSecrets is false (editing an already-configured plugin)", () => {
    const result = validatePluginConfigDraft(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 5 }, {}, false);
    expect(result.valid).toBe(true);
  });

  it("an out-of-range number fails with a field-level error", () => {
    const result = validatePluginConfigDraft(CONFIG_SCHEMA, { fixturePrefix: "X", maxResults: 999 }, { webhookUrl: "y" }, true);
    expect(result.valid).toBe(false);
    expect(result.errors["maxResults"]).toBeTruthy();
  });
});

describe("requestedEventTypes / isValidGrantSubset", () => {
  it("collects the union of every event-subscriber capability's eventTypes, deduplicated, first-seen order", () => {
    const capabilities: PluginCapability[] = [
      METADATA_CAP,
      { type: "event-subscriber", eventTypes: ["item.added", "playback.started"], contentClass: "general" },
      { type: "event-subscriber", eventTypes: ["playback.started", "settings.updated"], contentClass: "general" },
    ];
    expect(requestedEventTypes(capabilities)).toEqual(["item.added", "playback.started", "settings.updated"]);
  });

  it("returns an empty list when no capability is an event-subscriber", () => {
    expect(requestedEventTypes([METADATA_CAP])).toEqual([]);
  });

  it("isValidGrantSubset: true iff every granted type is requested", () => {
    expect(isValidGrantSubset(["a", "b"], ["a"])).toBe(true);
    expect(isValidGrantSubset(["a", "b"], ["a", "b"])).toBe(true);
    expect(isValidGrantSubset(["a", "b"], [])).toBe(true);
    expect(isValidGrantSubset(["a", "b"], ["c"])).toBe(false);
  });
});
