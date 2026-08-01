// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/layers.ts
//
// Mechanical extraction from metadata/consumer.ts (Stash mission, STATE.md
// K5/K11): buildLayers/toProvenanceMap were private helpers inside
// consumer.ts's own module scope, feeding precedence.ts's mergeFields.
// apps/worker/src/stash/apply.ts (Lane B) needs the EXACT same
// layer-seeding behavior — "read current provenance to know which of
// nfo/tags/filename the CURRENTLY-persisted value already represents, so a
// higher-precedence local source still wins over a new provider value even
// when unlocked" — so it is lifted here verbatim (zero logic change) and
// consumer.ts now imports it from this file instead of defining it inline.
// consumer.spec.ts stays green across the move (same behavior, new
// location) — see that spec for the regression proof.

export type { ExistingProvenance, FieldSource, LayeredFields } from './precedence.js';
import type { ExistingProvenance, FieldSource, LayeredFields } from './precedence.js';
import type { MetadataItemType } from './item-read.js';

/** Converts metadata_provenance rows (as read by
 *  @loombre/db/internal's getProvenanceForItem) into the field-keyed map
 *  mergeFields/buildLayers expect. */
export function toProvenanceMap(rows: { field: string; source: string; locked: boolean }[]): ExistingProvenance {
  const map: ExistingProvenance = {};
  for (const row of rows) {
    map[row.field] = { source: row.source as FieldSource, locked: row.locked };
  }
  return map;
}

/** Builds the {nfo, tags, provider, filename} layers for every field a
 *  caller knows how to write, seeding the nfo/tag/filename layers from
 *  whatever is CURRENTLY persisted when that field's existing provenance
 *  says it came from that source ("read current provenance to know
 *  layers" — the DB has no separate shadow copy of each source's value,
 *  so the persisted value IS that source's value when provenance says so).
 *
 *  `itemType` is accepted for call-site documentation/future
 *  differentiation but not currently read in the body — every field name
 *  present in `current`/`providerFields` (plus the always-considered
 *  relation fields) gets a layer regardless of item type. Kept as-is by
 *  this extraction (verbatim lift, see this file's header). */
export function buildLayers(
  itemType: MetadataItemType,
  providerFields: Record<string, unknown>,
  current: Record<string, unknown>,
  existingProvenance: ExistingProvenance
): LayeredFields {
  void itemType;
  const fieldNames = new Set([...Object.keys(current), ...Object.keys(providerFields), 'genres', 'tags', 'people']);
  const layers: LayeredFields = {};

  for (const field of fieldNames) {
    const source = existingProvenance[field]?.source;
    const layer: LayeredFields[string] = {};
    if (source === 'nfo' && field in current) layer.nfo = current[field];
    if (source === 'tag' && field in current) layer.tags = current[field];
    if (source === 'filename' && field in current) layer.filename = current[field];
    if (field in providerFields) layer.provider = providerFields[field];
    layers[field] = layer;
  }

  return layers;
}

/** Deep-ish equality for deciding which merged fields actually CHANGED
 *  (vs. resolved to the same value already persisted) — used to build the
 *  `item.updated` event's `changedFields` list. Same extraction rationale
 *  as buildLayers/toProvenanceMap above (verbatim lift out of
 *  consumer.ts). Arrays compare element-wise (order-sensitive, matching
 *  genres/tags/people's own list semantics); plain objects fall back to a
 *  JSON.stringify comparison (adequate for this module's value shapes —
 *  scalars, string arrays, and PersonCredit-shaped objects with a stable
 *  key order coming from the SAME mapping function on both sides). */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
