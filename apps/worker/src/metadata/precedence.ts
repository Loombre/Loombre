// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/precedence.ts
//
// mergeFields (P1.7, docs/PLAN.md §8.1/§8.3): pure per-field precedence —
// local NFO/tags > provider > filename inference — with locked fields never
// overwritten regardless of source. Pure function, zero I/O: the metadata
// consumer (consumer.ts) is the only caller that talks to the database.

export type FieldSource = 'nfo' | 'tag' | 'provider:tmdb' | 'provider:tvdb' | 'provider:musicbrainz' | 'filename';

export type ProviderFieldSource = Extract<FieldSource, `provider:${string}`>;

/** The four input layers for one field. A layer is omitted (not merely
 *  `undefined`) when that source has no opinion on the field at all — see
 *  the "absent layers skip" test cases in test/metadata/precedence.spec.ts. */
export interface FieldLayers {
  nfo?: unknown;
  tags?: unknown;
  provider?: unknown;
  filename?: unknown;
}

export type LayeredFields = Record<string, FieldLayers>;

export interface ExistingProvenanceEntry {
  source: FieldSource;
  locked: boolean;
}

/** Current provenance state, keyed by field name — typically built from
 *  @loombre/db/internal's getProvenanceForItem() rows by the caller. */
export type ExistingProvenance = Record<string, ExistingProvenanceEntry>;

export interface MergeFieldsResult {
  /** Only fields that were (a) not locked and (b) had at least one layer
   *  present. Callers write exactly these fields and nothing else — a field
   *  absent from this map must not be touched in the DB. */
  fields: Record<string, unknown>;
  provenance: { field: string; source: FieldSource }[];
}

const LAYER_PRECEDENCE: readonly (keyof FieldLayers)[] = ['nfo', 'tags', 'provider', 'filename'];

function layerSource(layer: keyof FieldLayers, providerSource: ProviderFieldSource): FieldSource {
  switch (layer) {
    case 'nfo':
      return 'nfo';
    case 'tags':
      return 'tag';
    case 'provider':
      return providerSource;
    case 'filename':
      return 'filename';
  }
}

/**
 * Resolves each field in `layers` to a single winning value + provenance
 * source, per-FIELD precedence nfo > tags > provider > filename, skipping
 * fields whose metadata_provenance row (from `existingProvenance`, refined
 * by any same-request `locks` override) is locked. Locked fields are
 * omitted from the result entirely, so the caller's write path leaves
 * whatever value is already persisted untouched — "never overwritten by
 * any source" is enforced by absence, not by re-writing the same value.
 */
export function mergeFields(
  layers: LayeredFields,
  existingProvenance: ExistingProvenance = {},
  locks: Record<string, boolean> = {},
  providerSource: ProviderFieldSource = 'provider:tmdb'
): MergeFieldsResult {
  const fields: Record<string, unknown> = {};
  const provenance: { field: string; source: FieldSource }[] = [];

  for (const [field, fieldLayers] of Object.entries(layers)) {
    const isLocked = locks[field] ?? existingProvenance[field]?.locked ?? false;
    if (isLocked) {
      continue;
    }

    const winningLayer = LAYER_PRECEDENCE.find((layer) => fieldLayers[layer] !== undefined);
    if (!winningLayer) {
      continue;
    }

    fields[field] = fieldLayers[winningLayer];
    provenance.push({ field, source: layerSource(winningLayer, providerSource) });
  }

  return { fields, provenance };
}
