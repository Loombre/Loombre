// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/test/fixtures.ts
//
// Shared valid fixtures reused across the schema/envelope/capability spec
// files, kept as plain-object builders (not zod-typed constants) so a test
// mutating a returned fixture can never affect another test's copy.

import type { LppMetadataProviderCapability, LppEventSubscriberCapability } from "../src/capabilities/index.js";
import type { LppManifest } from "../src/envelope.js";
import type { LppConfig } from "../src/json-schema-subset.js";

export function metadataProviderCapabilityFixture(): LppMetadataProviderCapability {
  return {
    type: "metadata-provider",
    mediaKinds: ["movie", "tv", "music"],
    contentClass: "general",
    endpoints: {
      search: "/lpp/provider/search",
      details: "/lpp/provider/details",
      images: "/lpp/provider/images",
    },
  };
}

export function eventSubscriberCapabilityFixture(): LppEventSubscriberCapability {
  return {
    type: "event-subscriber",
    eventTypes: ["item.added", "playback.started"],
    delivery: { endpoint: "/lpp/events" },
    contentClass: "general",
  };
}

export function emptyConfigSchemaFixture(): LppConfig {
  return { type: "object", properties: {}, additionalProperties: false };
}

export function secretConfigSchemaFixture(): LppConfig {
  return {
    type: "object",
    properties: {
      webhookUrl: { type: "string", description: "Webhook URL", secret: true },
    },
    required: ["webhookUrl"],
    additionalProperties: false,
  };
}

export function manifestFixture(overrides: Partial<LppManifest> = {}): LppManifest {
  return {
    name: "fixture-plugin",
    version: "0.1.0",
    protocolVersion: 1,
    capabilities: [metadataProviderCapabilityFixture()],
    configSchema: emptyConfigSchemaFixture(),
    description: "A fixture plugin manifest.",
    publisher: "Loombre",
    ...overrides,
  };
}
