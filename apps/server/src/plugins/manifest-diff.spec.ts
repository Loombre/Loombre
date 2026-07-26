// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/manifest-diff.spec.ts
//
// Exhaustive matrix for diffManifestForExpansion (LD6: "define the diff
// precisely and test it") — pure function, no DB/network.

import { describe, expect, it } from "vitest";
import type { LppManifest } from "@loombre/plugin-protocol";
import { diffManifestForExpansion } from "./manifest-diff.js";

function manifest(overrides: Partial<LppManifest> = {}): LppManifest {
  return {
    name: "fixture",
    version: "1.0.0",
    protocolVersion: 1,
    capabilities: [
      {
        type: "metadata-provider",
        mediaKinds: ["movie"],
        contentClass: "general",
        endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
      },
    ],
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    description: "fixture",
    publisher: "Loombre",
    ...overrides,
  };
}

describe("diffManifestForExpansion", () => {
  it("identical manifest -> not expanded, grants unchanged", () => {
    const m = manifest();
    const result = diffManifestForExpansion(m, m, ["metadata-provider"], []);
    expect(result.expanded).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.narrowedGrantedCapabilityTypes).toEqual(["metadata-provider"]);
  });

  it("a brand-new capability type is an expansion, even if not granted", () => {
    const oldM = manifest();
    const newM = manifest({
      capabilities: [
        ...oldM.capabilities,
        { type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
      ],
    });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("event-subscriber"))).toBe(true);
  });

  it("broader mediaKinds on a GRANTED capability is an expansion", () => {
    const oldM = manifest();
    const newM = manifest({
      capabilities: [{ ...oldM.capabilities[0]!, mediaKinds: ["movie", "tv"] } as LppManifest["capabilities"][number]],
    });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("mediaKinds broadened"))).toBe(true);
  });

  it("narrower mediaKinds is NOT an expansion", () => {
    const endpoints = { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" };
    const oldM = manifest({
      capabilities: [{ type: "metadata-provider", mediaKinds: ["movie", "tv"], contentClass: "general", endpoints }],
    });
    const newM = manifest({
      capabilities: [{ type: "metadata-provider", mediaKinds: ["movie"], contentClass: "general", endpoints }],
    });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(false);
  });

  it("contentClass widened general -> restricted on a granted capability is an expansion", () => {
    const oldM = manifest();
    const newM = manifest({ capabilities: [{ ...oldM.capabilities[0]!, contentClass: "restricted" } as LppManifest["capabilities"][number]] });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("contentClass widened"))).toBe(true);
  });

  it("contentClass narrowed restricted -> general is NOT an expansion", () => {
    const oldM = manifest({ capabilities: [{ ...manifest().capabilities[0]!, contentClass: "restricted" } as LppManifest["capabilities"][number]] });
    const newM = manifest();
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(false);
  });

  it("broader eventTypes REQUEST on a granted event-subscriber capability is an expansion", () => {
    const oldM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
    });
    const newM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added", "playback.started"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
    });
    const result = diffManifestForExpansion(oldM, newM, ["event-subscriber"], ["item.added"]);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("eventTypes request broadened"))).toBe(true);
  });

  it("narrower eventTypes request is NOT an expansion, and event grants are narrowed to the new request set", () => {
    const oldM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added", "playback.started"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
    });
    const newM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
    });
    const result = diffManifestForExpansion(oldM, newM, ["event-subscriber"], ["item.added", "playback.started"]);
    expect(result.expanded).toBe(false);
    expect(result.narrowedEventGrants).toEqual(["item.added"]);
  });

  it("a granted capability type removed entirely from the new manifest is NOT an expansion; it is dropped from the granted set", () => {
    const oldM = manifest({
      capabilities: [
        manifest().capabilities[0]!,
        { type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
      ],
    });
    const newM = manifest(); // event-subscriber capability dropped entirely
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider", "event-subscriber"], ["item.added"]);
    expect(result.expanded).toBe(false);
    expect(result.narrowedGrantedCapabilityTypes).toEqual(["metadata-provider"]);
    expect(result.narrowedEventGrants).toEqual([]);
  });

  it("a change on a capability type that was NEVER granted does not count as an expansion", () => {
    const oldM = manifest({
      capabilities: [
        manifest().capabilities[0]!,
        { type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
      ],
    });
    const newM = manifest({
      capabilities: [
        manifest().capabilities[0]!,
        { type: "event-subscriber", eventTypes: ["item.added", "playback.started"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
      ],
    });
    // Only metadata-provider is granted — the event-subscriber capability's
    // broadened eventTypes request is irrelevant since it was never approved.
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(false);
  });

  it("H-5: an endpoint path change on a granted metadata-provider capability is an expansion (re-approval axis)", () => {
    const oldM = manifest();
    const newM = manifest({
      capabilities: [
        {
          ...oldM.capabilities[0]!,
          endpoints: { search: "//attacker.example/collect", details: "/lpp/provider/details", images: "/lpp/provider/images" },
        } as LppManifest["capabilities"][number],
      ],
    });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("endpoint path"))).toBe(true);
  });

  it("H-5: a delivery endpoint change on a granted event-subscriber capability is an expansion", () => {
    const oldM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
    });
    const newM = manifest({
      capabilities: [{ type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/elsewhere" }, contentClass: "general" }],
    });
    const result = diffManifestForExpansion(oldM, newM, ["event-subscriber"], ["item.added"]);
    expect(result.expanded).toBe(true);
    expect(result.reasons.some((r) => r.includes("delivery endpoint path changed"))).toBe(true);
  });

  it("identical endpoint paths are NOT an expansion (endpoint-diff is byte comparison, not always-flag)", () => {
    const m = manifest();
    const result = diffManifestForExpansion(m, m, ["metadata-provider"], []);
    expect(result.expanded).toBe(false);
  });

  it("multiple simultaneous expansions all appear in reasons", () => {
    const oldM = manifest();
    const newM = manifest({
      capabilities: [
        { ...oldM.capabilities[0]!, mediaKinds: ["movie", "tv", "music"], contentClass: "restricted" } as LppManifest["capabilities"][number],
        { type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
      ],
    });
    const result = diffManifestForExpansion(oldM, newM, ["metadata-provider"], []);
    expect(result.expanded).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
