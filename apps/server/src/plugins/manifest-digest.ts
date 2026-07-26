// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/manifest-digest.ts
//
// C-2 fix wave: closes the preview<->register/reapprove manifest TOCTOU.
// Before this fix, C4's confirmation flow was two independent
// unauthenticated-to-the-host fetches with nothing pinning them together —
// `POST /admin/plugins/preview` fetched and rendered manifest A, then
// `POST /admin/plugins`/`POST /admin/plugins/{id}/reapprove` fetched a
// SEPARATE manifest B seconds later and persisted THAT one. A plugin
// operator who can distinguish the two requests (trivial: the second one is
// the only POST-triggered one) can serve a broader/more-restricted/secret-
// downgraded manifest B while showing the admin an honest manifest A.
//
// The fix: `POST /admin/plugins/preview` returns a canonical digest of the
// EXACT manifest content it validated (this file's `computeManifestDigest`).
// The wizard/re-approval UI must round-trip that digest back on
// register/reapprove; the service re-fetches (as before — there is no way
// to "reuse" an unauthenticated fetch across two separate HTTP requests
// safely) and 409s if the freshly-fetched manifest's digest does not match
// what the admin actually saw. A MATCHING digest is a cryptographic proof
// that the manifest register/reapprove is about to persist is
// byte-for-byte (structurally) identical to what preview rendered — so
// resolving secret/non-secret against the FRESHLY-fetched configSchema at
// that point is equivalent to resolving it against "the approved schema"
// (C-2's remediation direction) without needing to thread the actual
// preview-time schema object across two unrelated HTTP requests.
//
// Hashes the PARSED, TYPED `LppManifest` (post `parseLppManifest`), not the
// raw response bytes: zod's `.strict()` schemas already guarantee no stray
// fields can survive parsing, so this digest is insensitive to incidental
// transport-level formatting (whitespace, key order) a plugin's JSON
// serializer might vary between two responses with IDENTICAL semantic
// content — exactly the granularity C-2 cares about (did the APPROVED
// CONTENT change), not "were the exact bytes on the wire identical".

import { createHash } from "node:crypto";
import type { LppManifest } from "@loombre/plugin-protocol";

/** Deterministic (stable key order) JSON serialization — object keys sorted,
 *  arrays preserve element order (order is semantically significant for
 *  `capabilities`/`mediaKinds`/`eventTypes`/etc., never reordered). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex digest of the manifest's canonical serialization — the value
 *  `PluginManifestPreviewDto.manifestDigest` carries and
 *  register/reapprove pin against. */
export function computeManifestDigest(manifest: LppManifest): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}
