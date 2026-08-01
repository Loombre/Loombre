// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure prefix-rewrite functions for the Stash provider's per-library path
 * mapping (STATE.md S4: "primary = canonical file path AFTER a per-library
 * path-mapping table (Stash path prefixes <-> Loombre mount view)"; K10:
 * "the pure prefix-rewrite functions in packages/shared (unit-tested;
 * longest-prefix-wins, case handling and trailing-slash handling
 * explicit)"). Zero I/O, zero DB — packages/db's computePathMappingMatchPreview
 * and apps/worker/src/stash/matching.ts both call this directly against
 * rows they've already read.
 *
 * Design decisions (deliberate, tested below):
 *   - LONGEST-PREFIX-WINS: when a library configures multiple mappings
 *     whose stashPrefix values overlap (e.g. a general mapping for the
 *     whole Stash library root plus a more specific one for a
 *     sub-directory), the most specific (longest) matching prefix is used
 *     — independent of the mappings' stored `position`/array order, which
 *     is display ordering only, not matching precedence.
 *   - SEGMENT-BOUNDARY MATCHING: a prefix only matches at a path-segment
 *     boundary. "/mnt/stash" must not match "/mnt/stash2/foo.mp4" — a
 *     naive `.startsWith()` would.
 *   - CASE-SENSITIVE: matching never folds case. A case-insensitive match
 *     could silently collide two distinct paths on a case-sensitive
 *     filesystem; an admin whose Stash instance reports a different case
 *     convention must configure the mapping in that exact case.
 *   - BACKSLASH NORMALIZATION: Stash instances that scanned a Windows
 *     filesystem store `\`-separated paths; both the configured prefix and
 *     the input path are normalized to `/` before comparison so a Windows-
 *     sourced Stash path can still be mapped onto a POSIX Loombre mount.
 */

export interface StashPathMapping {
  stashPrefix: string;
  loombrePrefix: string;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Strips a single trailing slash, but never reduces a bare "/" to "". */
function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizedPrefix(prefix: string): string {
  return stripTrailingSlash(normalizeSlashes(prefix));
}

/**
 * Rewrites a Stash-reported file path onto its Loombre-mount equivalent
 * using the longest matching configured prefix. Returns `null` when no
 * configured mapping's `stashPrefix` matches `stashPath` at a segment
 * boundary — the caller (matching.ts) treats `null` as "no path-mapping
 * candidate", falling through to the oshash secondary match per S4.
 */
export function rewriteStashPath(stashPath: string, mappings: readonly StashPathMapping[]): string | null {
  const normalizedPath = normalizeSlashes(stashPath);

  let best: StashPathMapping | null = null;
  let bestPrefixLength = -1;

  for (const mapping of mappings) {
    const prefix = normalizedPrefix(mapping.stashPrefix);
    if (prefix.length === 0) continue;

    const matchesExactly = normalizedPath === prefix;
    const matchesAtBoundary = normalizedPath.startsWith(`${prefix}/`);
    if (!matchesExactly && !matchesAtBoundary) continue;

    if (prefix.length > bestPrefixLength) {
      best = mapping;
      bestPrefixLength = prefix.length;
    }
  }

  if (!best) return null;

  const prefix = normalizedPrefix(best.stashPrefix);
  const loombrePrefix = normalizedPrefix(best.loombrePrefix);
  const remainder = normalizedPath.slice(prefix.length); // "" or "/rest/of/path"
  return loombrePrefix + remainder;
}
