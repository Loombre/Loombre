// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/manifest.spec.ts

import { describe, expect, it } from "vitest";
import { LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT, LPP_PROTOCOL_VERSION } from "@loombre/plugin-protocol";
import { extractEventSubscriberCapability, resolveDeliveryUrl } from "../../src/plugin-delivery/manifest.js";

function sampleManifest(overrides: { capabilities?: unknown[] } = {}) {
  return {
    name: "Test Plugin",
    version: "1.0.0",
    protocolVersion: LPP_PROTOCOL_VERSION,
    capabilities: overrides.capabilities ?? [
      {
        type: "event-subscriber",
        eventTypes: ["item.added", "user.created"],
        delivery: { endpoint: LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT },
        contentClass: "general",
      },
    ],
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    description: "test",
    publisher: "test",
  };
}

describe("extractEventSubscriberCapability", () => {
  it("extracts a valid event-subscriber capability entry", () => {
    const capability = extractEventSubscriberCapability(sampleManifest());
    expect(capability).not.toBeNull();
    expect(capability?.delivery.endpoint).toBe(LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT);
    expect(capability?.eventTypes).toEqual(["item.added", "user.created"]);
  });

  it("returns null when the manifest has no event-subscriber capability at all", () => {
    const manifest = sampleManifest({
      capabilities: [{ type: "metadata-provider", mediaKinds: ["movie"], contentClass: "general", endpoints: { search: "/s", details: "/d", images: "/i" } }],
    });
    expect(extractEventSubscriberCapability(manifest)).toBeNull();
  });

  it("returns null when the entry is malformed (missing required delivery.endpoint)", () => {
    const manifest = sampleManifest({ capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: {}, contentClass: "general" }] });
    expect(extractEventSubscriberCapability(manifest)).toBeNull();
  });

  it("returns null when `capabilities` is not an array", () => {
    expect(extractEventSubscriberCapability({ capabilities: "not-an-array" })).toBeNull();
  });

  it("finds the event-subscriber entry among multiple capabilities", () => {
    const manifest = sampleManifest({
      capabilities: [
        { type: "metadata-provider", mediaKinds: ["movie"], contentClass: "general", endpoints: { search: "/s", details: "/d", images: "/i" } },
        { type: "event-subscriber", eventTypes: ["scan.completed"], delivery: { endpoint: "/custom/events" }, contentClass: "restricted" },
      ],
    });
    const capability = extractEventSubscriberCapability(manifest);
    expect(capability?.delivery.endpoint).toBe("/custom/events");
    expect(capability?.contentClass).toBe("restricted");
  });
});

describe("resolveDeliveryUrl", () => {
  it("joins the plugin's base_url origin with the capability's delivery path", () => {
    const capability = extractEventSubscriberCapability(sampleManifest())!;
    expect(resolveDeliveryUrl("http://127.0.0.1:4000", capability)).toBe(`http://127.0.0.1:4000${LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT}`);
  });

  it("works with a base_url that already has a trailing path segment", () => {
    const capability = extractEventSubscriberCapability(sampleManifest({ capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }] }))!;
    expect(resolveDeliveryUrl("http://example.com", capability)).toBe("http://example.com/lpp/events");
  });
});
