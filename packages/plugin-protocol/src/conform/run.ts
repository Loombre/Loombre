// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/run.ts
//
// Orchestrates the full `pnpm lpp:conform <url>` run: fetch + validate the
// manifest, then run each declared capability's suite in manifest order.
// This is the library entry point both the CLI (cli.ts) and this package's
// own integration test (test/integration.spec.ts) call — the CLI adds
// nothing beyond argv parsing and human-readable printing.

import type { LppConformFetch } from "./http.js";
import { checkLppManifest } from "./manifest-checks.js";
import { runMetadataProviderSuite } from "./metadata-provider-suite.js";
import { runEventSubscriberSuite } from "./event-subscriber-suite.js";
import type { LppConformanceReport, LppSuiteReport } from "./types.js";

export interface LppConformOptions extends LppConformFetch {
  nowMs?: number;
  /** Sent as `X-LPP-Config` for suites that exercise config-bearing
   *  endpoints (currently: event-subscriber delivery). */
  config?: Record<string, unknown>;
  /** Sent as `X-LPP-Secret-<NAME>` per entry (key = configSchema field name). */
  secrets?: Record<string, string>;
  /** Delivery-signing secret for event-subscriber capability checks. Absent
   *  => those checks degrade to a single `warn` (see event-subscriber-suite.ts). */
  signingSecret?: string;
  replayWindowMs?: number;
}

export async function runLppConformance(baseUrl: string, options: LppConformOptions = {}): Promise<LppConformanceReport> {
  const nowMs = options.nowMs ?? Date.now();
  const suites: LppSuiteReport[] = [];

  const manifestCheck = await checkLppManifest(baseUrl, options);
  suites.push(manifestCheck.suite);

  if (manifestCheck.manifest) {
    for (const capability of manifestCheck.manifest.capabilities) {
      if (capability.type === "metadata-provider") {
        suites.push(await runMetadataProviderSuite(baseUrl, capability, options));
      } else if (capability.type === "event-subscriber") {
        suites.push(
          await runEventSubscriberSuite(baseUrl, capability, {
            ...options,
            nowMs,
            ...(options.signingSecret !== undefined ? { signingSecret: options.signingSecret } : {}),
          }),
        );
      }
      // C8: a future capability type is handled by a new `else if` branch
      // here — the manifest parse stage already rejected any UNKNOWN type
      // before this loop runs (envelope.ts's parseLppManifest), so every
      // `capability.type` reaching this loop is one this package's
      // CAPABILITY_TYPES recognizes.
    }
  }

  return {
    targetUrl: baseUrl,
    generatedAtMs: nowMs,
    manifest: manifestCheck.manifest,
    suites,
    ok: suites.every((suite) => suite.checks.every((check) => check.severity !== "fail")),
  };
}
