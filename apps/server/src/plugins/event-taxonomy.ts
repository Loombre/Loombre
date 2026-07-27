// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/event-taxonomy.ts
//
// LD6: "validate eventTypes requested by any event-subscriber capability
// against the published outbox taxonomy (source it from
// packages/contract/event-schemas envelope enum — single source; add a
// tiny export/reader if the contract package lacks one, but do NOT touch
// openapi.yaml)". @loombre/contract ships no importable code today (only
// openapi.yaml + event-schemas/*.json — see scripts/check-runtime-imports.mjs's
// RUNTIME_EXEMPT comment) — rather than growing it a real src/+dist build
// for one small reader, this module reads its ALREADY-SHIPPED
// envelope.schema.json file directly off disk (packages/contract's
// package.json "files" already lists "event-schemas"), resolved via
// Node's own package resolution for "@loombre/contract/package.json" so
// this works identically in a pnpm workspace symlink and in an installed
// tarball/Docker image layout, without adding a code dependency edge check-
// runtime-imports.mjs would need to police.
//
// Cached at module scope after the first read (an admin-only, non-hot-path
// operation — registration/re-fetch — so a cache is a nicety, not a Tier-0
// requirement, but there is no reason to re-read+re-parse the same file on
// every call either).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADMIN_ONLY_EVENT_TYPES } from "@loombre/shared/admin-only-event-types";

let cachedTaxonomy: readonly string[] | undefined;

interface EnvelopeSchemaShape {
  properties: {
    type: {
      enum: string[];
    };
  };
}

/**
 * L3 (owner brief): `ADMIN_ONLY_EVENT_TYPES` moved to
 * packages/shared/src/admin-only-event-types.ts — that module is now the
 * single canonical source (full provenance/derivation-site list lives in
 * its header) and this is a straight re-export, kept under its original
 * name so both of this module's importers
 * (apps/server/src/gateway/ws-broadcaster.service.ts and
 * apps/server/src/plugins/plugin-registration.service.ts's
 * validateGrantAgainstManifest) keep working unchanged.
 *
 * H-4 fix wave (why this classification exists at all): the ten event
 * `type`s here are the ones `ws-broadcaster.service.ts` never delivers to
 * a non-admin socket. Before that fix, `getOutboxEventTaxonomy()` returned
 * the WHOLE envelope enum with no such exclusion, so a plugin's manifest
 * could REQUEST any of these, an admin could GRANT them, and the delivery
 * loop had no admin-only gate at all — an out-of-process third party could
 * receive `plugin.updated` (another plugin's full baseUrl/config/grants),
 * `settings.updated` (every server-setting value), or `job.updated` (see
 * M-7) purely by grant, on a platform that otherwise refuses to show any
 * of this to a logged-in non-admin USER over the very same live-event
 * mechanism (ws-broadcaster's own ADMIN_ONLY gate). Excluding these from
 * the GRANTABLE taxonomy in v1 means: a manifest requesting one is
 * rejected exactly like requesting an event type Loombre does not publish
 * at all (same 422, same message — `validateGrantAgainstManifest`'s
 * existing "does not publish" check), never silently ignored, and no
 * grant referencing one can ever be created.
 */
export { ADMIN_ONLY_EVENT_TYPES };

/** Returns the GRANTABLE set of outbox event `type` values — the closed
 *  envelope enum (packages/contract/event-schemas/envelope.schema.json's
 *  `type.enum`) MINUS `ADMIN_ONLY_EVENT_TYPES` (H-4 fix wave: those ten
 *  types can be neither requested by a plugin manifest nor granted by an
 *  admin in LPP v1 — see this file's header). Throws if the file cannot be
 *  located or is shaped unexpectedly (a packaging defect, not a plugin's
 *  fault — never silently returns an empty/partial taxonomy). */
export function getOutboxEventTaxonomy(): readonly string[] {
  if (cachedTaxonomy) return cachedTaxonomy;

  const require = createRequire(import.meta.url);
  const contractPackageJsonPath = require.resolve("@loombre/contract/package.json");
  const envelopeSchemaPath = path.join(path.dirname(contractPackageJsonPath), "event-schemas", "envelope.schema.json");

  const raw = readFileSync(envelopeSchemaPath, "utf8");
  const parsed = JSON.parse(raw) as EnvelopeSchemaShape;
  const enumValues = parsed.properties?.type?.enum;
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    throw new Error(`event-taxonomy: ${envelopeSchemaPath} did not contain a non-empty properties.type.enum array`);
  }

  const adminOnly = new Set(ADMIN_ONLY_EVENT_TYPES);
  cachedTaxonomy = Object.freeze(enumValues.filter((t) => !adminOnly.has(t)));
  return cachedTaxonomy;
}

/** Test-only escape hatch to force a re-read on the next call — production
 *  code never needs this (the taxonomy is effectively static for a given
 *  build). */
export function resetOutboxEventTaxonomyCacheForTests(): void {
  cachedTaxonomy = undefined;
}
