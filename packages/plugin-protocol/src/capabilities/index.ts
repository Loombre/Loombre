// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/capabilities/index.ts
//
// The discriminated-union Capability type (C2) plus a staged parser that
// gives the host a TYPED result distinguishing "I don't know this
// capability type at all" from "I know this type but this entry is
// malformed" — C2's "Unknown capability types must be REJECTED at
// registration with a clear 'this Loombre doesn't support X yet' — never
// silently ignored" requires exactly this distinction; zod's own
// discriminatedUnion parse failure collapses both cases into one generic
// error and cannot drive that message on its own.
//
// C8 additivity: a future capability type is purely a new member appended
// to `CAPABILITY_TYPES`/`LppCapabilitySchema`'s discriminatedUnion members
// list — this envelope (this file, envelope.ts) never changes shape.

import { z } from "zod";
import {
  LppEventSubscriberCapabilitySchema,
  type LppEventSubscriberCapability,
} from "./event-subscriber.js";
import {
  LppMetadataProviderCapabilitySchema,
  type LppMetadataProviderCapability,
} from "./metadata-provider.js";

export * from "./metadata-provider.js";
export * from "./event-subscriber.js";

export const CAPABILITY_TYPES = ["metadata-provider", "event-subscriber"] as const;

export type LppCapabilityType = (typeof CAPABILITY_TYPES)[number];

export const LppCapabilitySchema = z.discriminatedUnion("type", [
  LppMetadataProviderCapabilitySchema,
  LppEventSubscriberCapabilitySchema,
]);

export type LppCapability = LppMetadataProviderCapability | LppEventSubscriberCapability;

export type LppCapabilityParseResult =
  | { ok: true; capability: LppCapability }
  | { ok: false; reason: "unknown-capability-type"; type: string }
  | { ok: false; reason: "invalid-capability"; type: string; issues: z.core.$ZodIssue[] };

function isKnownCapabilityType(value: string): value is LppCapabilityType {
  return (CAPABILITY_TYPES as readonly string[]).includes(value);
}

/**
 * Parses one raw capability entry. A `type` that is missing, non-string, or
 * not in `CAPABILITY_TYPES` is reported as `"unknown-capability-type"` —
 * the host's registration path renders this as "this Loombre doesn't
 * support '<type>' yet", per C2. A recognized `type` whose fields fail
 * validation is `"invalid-capability"` instead (a real bug in the plugin's
 * manifest, not a version-skew situation).
 */
export function parseLppCapability(raw: unknown): LppCapabilityParseResult {
  const type =
    typeof raw === "object" && raw !== null && "type" in raw && typeof (raw as { type: unknown }).type === "string"
      ? (raw as { type: string }).type
      : undefined;

  if (type === undefined) {
    return { ok: false, reason: "invalid-capability", type: "(missing)", issues: [] };
  }
  if (!isKnownCapabilityType(type)) {
    return { ok: false, reason: "unknown-capability-type", type };
  }
  const result = LppCapabilitySchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: "invalid-capability", type, issues: result.error.issues };
  }
  return { ok: true, capability: result.data };
}

export interface LppCapabilitiesParseSummary {
  /** Successfully parsed capabilities, in input order. */
  capabilities: LppCapability[];
  /** One result per input entry, same order/length as the raw input array. */
  results: LppCapabilityParseResult[];
  /** Distinct unrecognized `type` values seen, in first-seen order. */
  unknownTypes: string[];
  /** C-1 fix wave: distinct `type` values that appear MORE THAN ONCE among
   *  the successfully-parsed entries, in first-seen order — see this
   *  function's own doc comment for why this is a hard rejection, not a
   *  "last one wins"/"first one wins" tolerance. */
  duplicateTypes: string[];
  hasErrors: boolean;
}

/**
 * C-1 fix wave (frozen-contract narrowing, D23 pre-release policy): "at most
 * one capability entry per `type`" is now an explicit rule, enforced here.
 *
 * Before this fix, nothing rejected a manifest with two entries of the same
 * `type` (e.g. two `metadata-provider` entries). Every consumer that reduces
 * `capabilities` to "the" entry of a given type used a DIFFERENT reduction —
 * `manifest-diff.ts` used `.find()` (the FIRST entry), while
 * `computeAggregateContentClass` used `.some()` (ANY entry) — so a plugin
 * could register with two identical-looking `general` entries, then on a
 * later refresh serve a manifest where only the SECOND entry's
 * `contentClass` flipped to `restricted`: the diff (comparing entry #1 to
 * entry #1) saw no change and took the non-expanding path, while the
 * aggregate (scanning ALL entries) silently recomputed `restricted` with no
 * re-approval, no `plugin.disabled`, no admin decision at all. Rejecting the
 * duplicate at parse time removes the ambiguity a "which entry counts" bug
 * could ever be built on, for every current and future consumer — not just
 * the two this review found.
 */
export function parseLppCapabilities(rawList: readonly unknown[]): LppCapabilitiesParseSummary {
  const results = rawList.map(parseLppCapability);
  const capabilities: LppCapability[] = [];
  const unknownTypes: string[] = [];
  const seenTypes = new Set<string>();
  const duplicateTypes: string[] = [];
  for (const result of results) {
    if (result.ok) {
      capabilities.push(result.capability);
      if (seenTypes.has(result.capability.type)) {
        if (!duplicateTypes.includes(result.capability.type)) {
          duplicateTypes.push(result.capability.type);
        }
      } else {
        seenTypes.add(result.capability.type);
      }
    } else if (result.reason === "unknown-capability-type" && !unknownTypes.includes(result.type)) {
      unknownTypes.push(result.type);
    }
  }
  return {
    capabilities,
    results,
    unknownTypes,
    duplicateTypes,
    hasErrors: results.some((r) => !r.ok) || duplicateTypes.length > 0,
  };
}
