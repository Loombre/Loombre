// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/manifest-diff.ts
//
// LD6's re-fetch flow: "fetch current manifest, diff vs snapshot; ANY
// expansion (new capability type, broader mediaKinds, contentClass change,
// broader eventTypes request… define the diff precisely and test it) =>
// plugin auto-disabled ... until re-approval". This module IS that precise
// definition — a pure function (no I/O, no DB, easy to exhaustively unit
// test) so plugin-registration.service.ts's refresh flow only has to call
// it and act on the verdict.
//
// EXPANSION (any one of these disables the plugin, reason='scope-change'):
//   1. A capability `type` the OLD manifest never declared appears in the
//      NEW manifest — regardless of whether it's currently granted (the
//      admin never had a chance to consider it).
//   2. For a capability type that is BOTH granted AND present in both
//      manifests:
//        - contentClass widened 'general' -> 'restricted'.
//        - metadata-provider: mediaKinds gained a NEW entry.
//        - event-subscriber: eventTypes (the REQUESTED set) gained a NEW
//          entry.
//
// NARROWING (never an expansion — grants shrink automatically, no
// re-approval needed): a granted capability type the new manifest no
// longer declares AT ALL is dropped from the effective grant; a granted
// event-subscriber's event-type grants are intersected with whatever the
// new manifest's event-subscriber capability still requests (dropped
// entirely, along with every one of its grants, if the capability type
// itself vanished). contentClass narrowing (restricted -> general) and
// mediaKinds narrowing are, symmetrically, never expansions either — only
// GROWTH along any axis counts.
//
// H-5 fix wave correction: endpoint path changes ARE now a re-approval axis
// (this file's own header used to say otherwise — that was itself the H-5
// finding: a plugin could redirect a granted capability's endpoint, incl.
// off-host via a protocol-relative path, on a bare refresh with no admin
// decision). description/publisher text changes and a plain version-string
// bump remain NOT scope concerns and are still silently carried by the
// non-expanding snapshot-update path.
//
// C-1 fix wave: `findCapability` below now operates over a manifest whose
// capabilities are GUARANTEED unique per `type` (duplicate `type` entries
// are rejected at parse time — packages/plugin-protocol's
// parseLppCapabilities), so `.find()` can no longer silently disagree with
// a consumer that scans every entry. As defense in depth (never rely on a
// single fix holding alone), this file now ALSO computes the derived
// aggregate content_class before/after and treats ANY widening as an
// expansion in its own right — `computeAggregateContentClass` used to be
// duplicated privately in plugin-registration.service.ts; it now lives here
// as the one place that recomputes it, so a future caller cannot reintroduce
// a silent-recompute path around this diff.

import type { LppCapability, LppEventSubscriberCapability, LppManifest, LppMetadataProviderCapability } from "@loombre/plugin-protocol";

export type LppManifestContentClass = "general" | "restricted";

/** The plugin's single AGGREGATE content_class: 'restricted' iff ANY
 *  GRANTED capability entry declares `contentClass: "restricted"`. Moved
 *  here (from plugin-registration.service.ts, C-1 fix wave) so this diff
 *  module is the sole place that recomputes it — see this file's header. */
export function computeAggregateContentClass(
  manifest: LppManifest,
  grantedCapabilityTypes: readonly string[],
): LppManifestContentClass {
  const anyRestricted = manifest.capabilities.some(
    (c) => grantedCapabilityTypes.includes(c.type) && c.contentClass === "restricted",
  );
  return anyRestricted ? "restricted" : "general";
}

export interface ManifestDiffResult {
  expanded: boolean;
  /** Human-readable reasons, empty iff !expanded — surfaced in the
   *  plugin.disabled(reason:'scope-change') admin-facing detail text. */
  reasons: string[];
  /** The GRANTED capability-type set, narrowed (never widened) to what the
   *  NEW manifest still declares. Only meaningful/applied by the caller
   *  when `expanded` is false — an expanding diff disables the plugin
   *  instead of applying any grant change at all. */
  narrowedGrantedCapabilityTypes: string[];
  /** The event-type grant set, narrowed to the intersection with whatever
   *  the new manifest's event-subscriber capability (if any, if still
   *  granted) still requests. */
  narrowedEventGrants: string[];
}

function findCapability(manifest: LppManifest, type: string): LppCapability | undefined {
  return manifest.capabilities.find((c) => c.type === type);
}

export function diffManifestForExpansion(
  oldManifest: LppManifest,
  newManifest: LppManifest,
  grantedCapabilityTypes: readonly string[],
  eventGrants: readonly string[],
): ManifestDiffResult {
  const reasons: string[] = [];

  const oldTypes = new Set<string>(oldManifest.capabilities.map((c) => c.type));
  const newTypes = new Set<string>(newManifest.capabilities.map((c) => c.type));

  for (const type of newTypes) {
    if (!oldTypes.has(type)) {
      reasons.push(`new capability type '${type}' declared (was not present before)`);
    }
  }

  for (const type of grantedCapabilityTypes) {
    const oldCap = findCapability(oldManifest, type);
    const newCap = findCapability(newManifest, type);
    if (!oldCap || !newCap) continue; // handled by narrowing below, never an expansion

    if (oldCap.contentClass === "general" && newCap.contentClass === "restricted") {
      reasons.push(`capability '${type}' contentClass widened from 'general' to 'restricted'`);
    }

    if (oldCap.type === "metadata-provider" && newCap.type === "metadata-provider") {
      const added = (newCap as LppMetadataProviderCapability).mediaKinds.filter(
        (k) => !(oldCap as LppMetadataProviderCapability).mediaKinds.includes(k),
      );
      if (added.length > 0) {
        reasons.push(`capability '${type}' mediaKinds broadened: +[${added.join(", ")}]`);
      }
    }

    if (oldCap.type === "event-subscriber" && newCap.type === "event-subscriber") {
      const added = (newCap as LppEventSubscriberCapability).eventTypes.filter(
        (t) => !(oldCap as LppEventSubscriberCapability).eventTypes.includes(t),
      );
      if (added.length > 0) {
        reasons.push(`capability '${type}' eventTypes request broadened: +[${added.join(", ")}]`);
      }
    }

    // H-5 fix wave: an endpoint-path change is now a re-approval axis in
    // its own right — a plugin's declared destination is part of what the
    // admin approved (C1: "base_url is meant to be the audited
    // destination"), and silently carrying a path change forward let a
    // plugin redirect a granted capability's traffic (config + secrets, or
    // a signed event batch) to a different path with zero admin signal.
    if (oldCap.type === "metadata-provider" && newCap.type === "metadata-provider") {
      const oldEp = (oldCap as LppMetadataProviderCapability).endpoints;
      const newEp = (newCap as LppMetadataProviderCapability).endpoints;
      const changedKeys = (["search", "details", "images"] as const).filter((k) => oldEp[k] !== newEp[k]);
      if (changedKeys.length > 0) {
        reasons.push(`capability '${type}' endpoint path(s) changed: ${changedKeys.map((k) => `${k}: '${oldEp[k]}' -> '${newEp[k]}'`).join(", ")}`);
      }
    }
    if (oldCap.type === "event-subscriber" && newCap.type === "event-subscriber") {
      const oldEndpoint = (oldCap as LppEventSubscriberCapability).delivery.endpoint;
      const newEndpoint = (newCap as LppEventSubscriberCapability).delivery.endpoint;
      if (oldEndpoint !== newEndpoint) {
        reasons.push(`capability '${type}' delivery endpoint path changed: '${oldEndpoint}' -> '${newEndpoint}'`);
      }
    }
  }

  const narrowedGrantedCapabilityTypes = grantedCapabilityTypes.filter((t) => newTypes.has(t));

  // C-1 fix wave, defense in depth: the derived aggregate content_class
  // must never widen general -> restricted except through a reason already
  // captured above — recomputed and compared explicitly rather than left to
  // a caller's own silent recompute (see this file's header).
  const oldAggregate = computeAggregateContentClass(oldManifest, grantedCapabilityTypes);
  const newAggregate = computeAggregateContentClass(newManifest, narrowedGrantedCapabilityTypes);
  if (oldAggregate === "general" && newAggregate === "restricted") {
    reasons.push(
      `derived aggregate content_class widened from 'general' to 'restricted' (a granted capability's effective scope changed)`,
    );
  }

  const expanded = reasons.length > 0;

  const newEventSubscriberCap = newManifest.capabilities.find(
    (c): c is LppEventSubscriberCapability => c.type === "event-subscriber",
  );
  const narrowedEventGrants =
    narrowedGrantedCapabilityTypes.includes("event-subscriber") && newEventSubscriberCap
      ? eventGrants.filter((t) => newEventSubscriberCap.eventTypes.includes(t))
      : [];

  return { expanded, reasons, narrowedGrantedCapabilityTypes, narrowedEventGrants };
}
