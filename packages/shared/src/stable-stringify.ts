// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recursively key-sorted `JSON.stringify`. Required so identical PlaybackPlan
 * values serialize byte-identically regardless of key insertion order
 * (docs/PLAYBACK.md §0 purity law, §5 serialization contract).
 */

function sortForStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStringify);
  }

  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = record[key];
      if (v === undefined) continue;
      out[key] = sortForStringify(v);
    }
    return out;
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStringify(value));
}
