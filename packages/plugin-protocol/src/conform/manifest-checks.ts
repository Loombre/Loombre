// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/manifest-checks.ts
//
// First stage of `pnpm lpp:conform <url>` (mission: "fetches /lpp/manifest,
// validates envelope + protocolVersion + capability schemas"). Everything
// downstream (per-capability suites) only runs when this stage produces a
// usable `LppManifest`.

import { describeLppManifestParseFailure, parseLppManifest, type LppManifest } from "../envelope.js";
import type { LppSuiteReport } from "./types.js";
import { lppConformRequest, tryParseJson, type LppConformFetch } from "./http.js";

export interface ManifestCheckResult {
  suite: LppSuiteReport;
  manifest?: LppManifest;
}

export async function checkLppManifest(baseUrl: string, opts: LppConformFetch = {}): Promise<ManifestCheckResult> {
  const checks: LppSuiteReport["checks"] = [];
  const url = new URL("/lpp/manifest", baseUrl).toString();

  let response;
  try {
    response = await lppConformRequest(url, { method: "GET" }, opts);
  } catch (err) {
    checks.push({
      id: "envelope.fetch",
      description: "GET /lpp/manifest is reachable",
      severity: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { suite: { suite: "envelope", checks } };
  }

  if (response.status !== 200) {
    checks.push({
      id: "envelope.fetch",
      description: "GET /lpp/manifest responds 200",
      severity: "fail",
      detail: `HTTP ${response.status}`,
    });
    return { suite: { suite: "envelope", checks } };
  }
  checks.push({ id: "envelope.fetch", description: "GET /lpp/manifest responds 200", severity: "pass" });

  const parsedJson = tryParseJson(response.bodyText);
  if (!parsedJson.ok) {
    checks.push({
      id: "envelope.json",
      description: "response body is valid JSON",
      severity: "fail",
      detail: parsedJson.error,
    });
    return { suite: { suite: "envelope", checks } };
  }
  checks.push({ id: "envelope.json", description: "response body is valid JSON", severity: "pass" });

  const parsed = parseLppManifest(parsedJson.value);
  if (!parsed.ok) {
    checks.push({
      id: "envelope.schema",
      description: "manifest matches the LPP v1 envelope schema",
      severity: "fail",
      detail: describeLppManifestParseFailure(parsed),
    });
    return { suite: { suite: "envelope", checks } };
  }
  checks.push({ id: "envelope.schema", description: "manifest matches the LPP v1 envelope schema", severity: "pass" });
  checks.push({
    id: "envelope.protocolVersion",
    description: "protocolVersion is supported by this conformance suite",
    severity: "pass",
    detail: `v${parsed.manifest.protocolVersion}`,
  });
  checks.push({
    id: "envelope.capabilities",
    description: "declares at least one supported capability",
    severity: "pass",
    detail: parsed.manifest.capabilities.map((c) => c.type).join(", "),
  });

  return { suite: { suite: "envelope", checks }, manifest: parsed.manifest };
}
