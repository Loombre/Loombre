// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/manifest.ts
//
// LPP v1, Lane W4 — extracts the event-subscriber capability's
// `delivery.endpoint` (a PATH, joined against plugins.base_url to form
// the full POST target) out of a plugin's verbatim manifest JSONB
// snapshot. Mirrors apps/worker/src/metadata/plugin-provider.ts's
// `extractMetadataProviderCapability` exactly — same reasoning: this
// parsing happens WORKER-SIDE (never in packages/db, which stays
// protocol-agnostic per packages/db/src/query/plugins-delivery.ts's own
// header) using @loombre/plugin-protocol's frozen wire schema, and a
// plugin whose GRANTED-but-malformed manifest entry fails validation is
// simply skipped (returns null) rather than crashing the delivery loop —
// C6's "no plugin can stall anything" applies to a bad manifest exactly
// as much as to a slow endpoint.

import { LppEventSubscriberCapabilitySchema, type LppEventSubscriberCapability } from "@loombre/plugin-protocol";

export function extractEventSubscriberCapability(manifest: Record<string, unknown>): LppEventSubscriberCapability | null {
  const raw = (manifest as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(raw)) return null;
  const entry = raw.find((c) => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "event-subscriber");
  if (!entry) return null;
  const parsed = LppEventSubscriberCapabilitySchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

/** H-5 fix wave: thrown when `delivery.endpoint` resolves to a different
 *  ORIGIN than the plugin's registered `base_url` — see resolveDeliveryUrl's
 *  doc comment. */
export class PluginEndpointOriginMismatchError extends Error {
  constructor(baseUrl: string, path: string, resolvedOrigin: string) {
    super(
      `event-subscriber delivery.endpoint "${path}" resolves to origin "${resolvedOrigin}", which does not match the plugin's registered baseUrl origin "${new URL(baseUrl).origin}" — refusing to deliver`,
    );
    this.name = "PluginEndpointOriginMismatchError";
  }
}

/** Full POST target for a delivery — `delivery.endpoint` is always a
 *  path (schema-enforced `^\/(?![/\\])`, H-5 fix wave), joined against the
 *  plugin's base_url origin (the SAME `new URL(path, baseUrl)` composition
 *  plugin-provider.ts's callLppEndpoint uses for search/details/images).
 *
 *  H-5 fix wave, defense in depth: asserts the resolved URL's origin
 *  strictly equals the plugin's registered baseUrl origin. The frozen path
 *  regex tightening is what actually prevents a protocol-relative
 *  (`//host`, `/\host`) path from validating at manifest-parse time — this
 *  is the SECOND, independent layer, so a stored manifest snapshot that
 *  predates the narrowing (or a future parser bug) can never make this loop
 *  ship a signed event batch — carrying restricted-content events for a
 *  restricted-scoped subscriber — to a host other than the one the admin
 *  approved. */
export function resolveDeliveryUrl(baseUrl: string, capability: LppEventSubscriberCapability): string {
  const resolved = new URL(capability.delivery.endpoint, baseUrl);
  const baseOrigin = new URL(baseUrl).origin;
  if (resolved.origin !== baseOrigin) {
    throw new PluginEndpointOriginMismatchError(baseUrl, capability.delivery.endpoint, resolved.origin);
  }
  return resolved.toString();
}
