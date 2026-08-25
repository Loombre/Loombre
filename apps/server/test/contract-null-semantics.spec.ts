// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/contract-null-semantics.spec.ts
//
// Remediation d3-b10 (P4, verify/browser-items-F6 follow-up).
//
// A schema member's DESCRIPTION is the only place a client learns what a
// `null` means. When the server grows a new reason to send null and the
// description keeps listing the old ones, the contract is quietly wrong in
// the way that is hardest to notice: every response still validates.
//
// browser-items-F6 gave `MediaFileSummary.hdr` a THIRD null meaning.
// `deriveHdrForDisplay` (packages/db/src/query/media-info.ts) returns null
// for a file that HAS a probed video stream when neither the stored `hdr`
// column nor `color_transfer` yields a verdict — deliberately, so an
// unknown verdict cannot read back as a confident "SDR" (the movie-detail
// VERSIONS card then omits the row). The contract still said null happened
// "alongside videoCodec/bitDepth for the same files", i.e. only for
// audio-only or not-yet-probed files — the two cases where those two
// members are also null. A client trusting that would conclude "hdr null
// AND videoCodec non-null" is impossible, which is exactly the shape
// browser-items-F6 introduced.
//
// Pure / file-read-only (contract-reason-codes.spec.ts's shape): no NestJS
// bootstrap, no database. Parses openapi.yaml directly — the SDK is
// generated FROM it, so asserting against the SDK would re-check codegen
// rather than the source of truth.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(__dirname, "../../../packages/contract/openapi.yaml");

interface OpenApiDoc {
  components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> };
}

function memberDescription(schema: string, member: string): string {
  const doc = parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDoc;
  const property = doc.components.schemas[schema]?.properties?.[member];
  expect(property, `openapi.yaml has no ${schema}.${member}`).toBeTruthy();
  return String(property!.description ?? "");
}

describe("d3-b10: MediaFileSummary.hdr documents every reason it can be null", () => {
  it("no longer claims null happens only alongside videoCodec/bitDepth", () => {
    const description = memberDescription("MediaFileSummary", "hdr");
    expect(
      description.trim(),
      "the pre-d3-b10 text described two of the three null cases as if they were all of them",
    ).not.toBe("Null alongside videoCodec/bitDepth for the same files.");
  });

  it("names the third case: a probed video file whose HDR verdict is UNKNOWN", () => {
    const description = memberDescription("MediaFileSummary", "hdr");
    // The two facts a client needs to act on: the verdict can be unknown,
    // and the fallback that decides it reads color_transfer.
    expect(description, "must say the verdict can be unknown").toMatch(/unknown/i);
    expect(description, "must name the color_transfer fallback").toMatch(/color[_ ]?transfer/i);
    // And it must be explicit that an unknown verdict is NOT "SDR" — the
    // whole point of browser-items-F6.
    expect(description).toMatch(/\bnone\b|\bSDR\b/i);
  });

  it("leaves the sibling members' two-case descriptions alone", () => {
    expect(memberDescription("MediaFileSummary", "videoCodec")).toBe(
      "Null for audio-only files or files not yet probed.",
    );
    expect(memberDescription("MediaFileSummary", "container")).toBe("Null until the file has been probed.");
  });
});
