// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/metadata-provider-suite.ts
//
// Capability 3.1 conformance: deterministic probe queries against
// search/details/images, schema-validating every response, plus one
// malformed-input probe per endpoint expecting RFC 9457 problem+json.

import {
  LppDetailsResponseSchema,
  LppImagesResponseSchema,
  LppSearchResponseSchema,
  type LppMetadataProviderCapability,
  type LppProviderRef,
  type LppSearchRequest,
} from "../capabilities/index.js";
import { LPP_PROBLEM_CONTENT_TYPE, LppProblemSchema } from "../problem.js";
import { lppConformRequest, tryParseJson, type LppConformFetch } from "./http.js";
import type { LppCheckResult, LppSuiteReport } from "./types.js";

/** Deterministic, obviously-fake probe title — reference/example plugins
 *  recognize this exact string is unimportant, they must simply respond
 *  schema-validly to ANY well-formed request. */
const PROBE_TITLE = "Loombre Conformance Probe Alpha";
const PROBE_YEAR = 2001;

function pickProbeMediaKind(capability: LppMetadataProviderCapability): LppSearchRequest["mediaKind"] {
  return capability.mediaKinds[0] ?? "movie";
}

function buildProbeSearchRequest(capability: LppMetadataProviderCapability): LppSearchRequest {
  const mediaKind = pickProbeMediaKind(capability);
  return {
    mediaKind,
    title: PROBE_TITLE,
    year: PROBE_YEAR,
    ...(mediaKind === "music" ? { entityKind: "artist" as const } : {}),
  };
}

async function postJson(
  url: string,
  body: unknown,
  opts: LppConformFetch,
): Promise<{ status: number; contentType: string | null; json: unknown; parseError?: string }> {
  const response = await lppConformRequest(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    opts,
  );
  const parsed = tryParseJson(response.bodyText);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    json: parsed.ok ? parsed.value : undefined,
    ...(parsed.ok ? {} : { parseError: parsed.error }),
  };
}

function checkProblemResponse(
  idPrefix: string,
  description: string,
  status: number,
  contentType: string | null,
  json: unknown,
  parseError: string | undefined,
): LppCheckResult {
  if (status < 400 || status > 499) {
    return { id: idPrefix, description, severity: "fail", detail: `expected 4xx, got HTTP ${status}` };
  }
  if (parseError) {
    return { id: idPrefix, description, severity: "fail", detail: `response body is not valid JSON: ${parseError}` };
  }
  if (!contentType || !contentType.includes(LPP_PROBLEM_CONTENT_TYPE)) {
    return {
      id: idPrefix,
      description,
      severity: "fail",
      detail: `expected content-type ${LPP_PROBLEM_CONTENT_TYPE}, got ${contentType ?? "(none)"}`,
    };
  }
  const problem = LppProblemSchema.safeParse(json);
  if (!problem.success) {
    return {
      id: idPrefix,
      description,
      severity: "fail",
      detail: `body is not RFC 9457 problem+json: ${problem.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { id: idPrefix, description, severity: "pass", detail: `HTTP ${status} ${problem.data.type}` };
}

export async function runMetadataProviderSuite(
  baseUrl: string,
  capability: LppMetadataProviderCapability,
  opts: LppConformFetch = {},
): Promise<LppSuiteReport> {
  const checks: LppCheckResult[] = [];
  const searchUrl = new URL(capability.endpoints.search, baseUrl).toString();
  const detailsUrl = new URL(capability.endpoints.details, baseUrl).toString();
  const imagesUrl = new URL(capability.endpoints.images, baseUrl).toString();

  // ---- search: happy path -------------------------------------------------
  const searchReq = buildProbeSearchRequest(capability);
  let ref: LppProviderRef | undefined;
  try {
    const search = await postJson(searchUrl, searchReq, opts);
    if (search.status !== 200) {
      checks.push({
        id: "metadata-provider.search.status",
        description: "POST search responds 200 for a well-formed query",
        severity: "fail",
        detail: `HTTP ${search.status}`,
      });
    } else {
      const parsed = LppSearchResponseSchema.safeParse(search.json);
      if (!parsed.success) {
        checks.push({
          id: "metadata-provider.search.schema",
          description: "search response matches SearchResponse schema",
          severity: "fail",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      } else {
        checks.push({ id: "metadata-provider.search.schema", description: "search response matches SearchResponse schema", severity: "pass" });
        ref = parsed.data.results[0]?.ref;
        if (!ref) {
          checks.push({
            id: "metadata-provider.search.results",
            description: "search returns at least one result for the probe query",
            severity: "warn",
            detail: "no results — details/images checks skipped",
          });
        } else {
          checks.push({ id: "metadata-provider.search.results", description: "search returns at least one result for the probe query", severity: "pass" });
        }
      }
    }
  } catch (err) {
    checks.push({ id: "metadata-provider.search.status", description: "POST search responds 200 for a well-formed query", severity: "fail", detail: String(err) });
  }

  // ---- search: malformed input --------------------------------------------
  try {
    const malformed = await postJson(searchUrl, { mediaKind: "not-a-real-media-kind", title: "" }, opts);
    checks.push(
      checkProblemResponse(
        "metadata-provider.search.malformed",
        "malformed search request yields RFC 9457 problem+json 4xx",
        malformed.status,
        malformed.contentType,
        malformed.json,
        malformed.parseError,
      ),
    );
  } catch (err) {
    checks.push({ id: "metadata-provider.search.malformed", description: "malformed search request yields RFC 9457 problem+json 4xx", severity: "fail", detail: String(err) });
  }

  // ---- details: happy path (only if we have a ref) -------------------------
  if (ref) {
    try {
      const details = await postJson(detailsUrl, { ref }, opts);
      if (details.status !== 200) {
        checks.push({ id: "metadata-provider.details.status", description: "POST details responds 200 for a ref returned by search", severity: "fail", detail: `HTTP ${details.status}` });
      } else {
        const parsed = LppDetailsResponseSchema.safeParse(details.json);
        checks.push(
          parsed.success
            ? { id: "metadata-provider.details.schema", description: "details response matches DetailsResponse schema", severity: "pass" }
            : {
                id: "metadata-provider.details.schema",
                description: "details response matches DetailsResponse schema",
                severity: "fail",
                detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
              },
        );
      }
    } catch (err) {
      checks.push({ id: "metadata-provider.details.status", description: "POST details responds 200 for a ref returned by search", severity: "fail", detail: String(err) });
    }
  }

  // ---- details: malformed input --------------------------------------------
  try {
    const malformed = await postJson(detailsUrl, { ref: { provider: "" } }, opts);
    checks.push(
      checkProblemResponse(
        "metadata-provider.details.malformed",
        "malformed details request yields RFC 9457 problem+json 4xx",
        malformed.status,
        malformed.contentType,
        malformed.json,
        malformed.parseError,
      ),
    );
  } catch (err) {
    checks.push({ id: "metadata-provider.details.malformed", description: "malformed details request yields RFC 9457 problem+json 4xx", severity: "fail", detail: String(err) });
  }

  // ---- images: happy path (only if we have a ref) ---------------------------
  if (ref) {
    try {
      const images = await postJson(imagesUrl, { ref }, opts);
      if (images.status !== 200) {
        checks.push({ id: "metadata-provider.images.status", description: "POST images responds 200 for a ref returned by search", severity: "fail", detail: `HTTP ${images.status}` });
      } else {
        const parsed = LppImagesResponseSchema.safeParse(images.json);
        checks.push(
          parsed.success
            ? { id: "metadata-provider.images.schema", description: "images response matches ImagesResponse schema", severity: "pass" }
            : {
                id: "metadata-provider.images.schema",
                description: "images response matches ImagesResponse schema",
                severity: "fail",
                detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
              },
        );
      }
    } catch (err) {
      checks.push({ id: "metadata-provider.images.status", description: "POST images responds 200 for a ref returned by search", severity: "fail", detail: String(err) });
    }
  }

  // ---- images: malformed input -----------------------------------------------
  try {
    const malformed = await postJson(imagesUrl, { ref: { provider: "" } }, opts);
    checks.push(
      checkProblemResponse(
        "metadata-provider.images.malformed",
        "malformed images request yields RFC 9457 problem+json 4xx",
        malformed.status,
        malformed.contentType,
        malformed.json,
        malformed.parseError,
      ),
    );
  } catch (err) {
    checks.push({ id: "metadata-provider.images.malformed", description: "malformed images request yields RFC 9457 problem+json 4xx", severity: "fail", detail: String(err) });
  }

  return { suite: "metadata-provider", checks };
}
