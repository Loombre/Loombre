// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/update-check/manifest-guard.ts
//
// Hand-rolled structural validation of a fetched (and by this point,
// signature-VERIFIED) manifest.json body against @loombre/release-manifest's
// shape. Deliberately NOT ajv-based: it checks exactly the fields
// update-check.service.ts reads (manifestVersion/channel/
// releases[].version+releasedAtMs+notesUrl) — a narrower, additive check
// than the frozen package's full JSON Schema
// (packages/release-manifest/src/manifest.ts's RELEASE_MANIFEST_SCHEMA is
// still the authoritative shape, exercised by that package's OWN test
// suite; this is "good enough to safely narrow the type before reading
// it", not a re-implementation of that schema).

import { RELEASE_MANIFEST_VERSION, RELEASE_CHANNELS, type ReleaseManifest } from "@loombre/release-manifest";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isWellFormedReleaseEntry(v: unknown): v is ReleaseManifest["releases"][number] {
  if (typeof v !== "object" || v === null) return false;
  const entry = v as Record<string, unknown>;
  return (
    isNonEmptyString(entry["version"]) &&
    typeof entry["releasedAtMs"] === "number" &&
    Number.isFinite(entry["releasedAtMs"]) &&
    isNonEmptyString(entry["notesUrl"]) &&
    Array.isArray(entry["artifacts"])
  );
}

/** Type guard: does `body` structurally look like a v1 ReleaseManifest? */
export function isWellFormedManifest(body: unknown): body is ReleaseManifest {
  if (typeof body !== "object" || body === null) return false;
  const manifest = body as Record<string, unknown>;

  if (manifest["manifestVersion"] !== RELEASE_MANIFEST_VERSION) return false;
  if (typeof manifest["channel"] !== "string" || !RELEASE_CHANNELS.includes(manifest["channel"] as never)) {
    return false;
  }
  if (!Array.isArray(manifest["releases"])) return false;
  return manifest["releases"].every(isWellFormedReleaseEntry);
}
