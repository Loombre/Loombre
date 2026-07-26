// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/update-check/semver-compare.ts
//
// Minimal semver PRECEDENCE comparator (semver.org §11) — just enough to
// pick "the newest release" out of a verified manifest's `releases[]`
// array. No new dependency: @loombre/release-manifest already validates
// each release's `version` field against the semver.org pattern
// (RELEASE_ENTRY_SCHEMA), so by the time this runs the inputs are known to
// be syntactically valid semver strings; this only orders them.

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Empty array = no prerelease (release versions sort AFTER any prerelease of the same major.minor.patch, per semver precedence rule 11). */
  prerelease: (string | number)[];
}

function parseSemver(version: string): ParsedSemver {
  const [core, prereleaseAndBuild] = version.split("-", 2) as [string, string | undefined];
  const [majorStr, minorStr, patchStr] = core.split(".") as [string, string, string];
  const prereleaseRaw = prereleaseAndBuild?.split("+")[0];
  const prerelease = prereleaseRaw
    ? prereleaseRaw.split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
    : [];
  return {
    major: Number.parseInt(majorStr, 10),
    minor: Number.parseInt(minorStr, 10),
    patch: Number.parseInt(patchStr, 10),
    prerelease,
  };
}

function comparePrereleaseIdentifier(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1; // numeric identifiers always have lower precedence than alphanumeric
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns -1 if `a` < `b`, 0 if equal precedence, 1 if `a` > `b` (semver.org §11 precedence rules). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // A version WITHOUT a prerelease has HIGHER precedence than one with.
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1; // shorter prerelease list has lower precedence
    if (bi === undefined) return 1;
    const cmp = comparePrereleaseIdentifier(ai, bi);
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }
  return 0;
}

/** Returns the highest-precedence version string in `versions`, or null for an empty array. */
export function maxSemver(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((max, current) => (compareSemver(current, max) > 0 ? current : max));
}
