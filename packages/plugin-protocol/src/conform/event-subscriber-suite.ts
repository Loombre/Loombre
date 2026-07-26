// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/event-subscriber-suite.ts
//
// Capability 3.2 conformance: delivers signed test batches. A valid
// signature MUST yield 2xx (fail otherwise). Tampered-body and
// stale-timestamp rejection are SHOULD-level (mission: "the suite
// documents/exercises plugin-side rejection as a SHOULD, reporting
// pass/warn") — a plugin that acks a tampered/stale batch anyway gets a
// `warn`, never a `fail`.
//
// Signature checks only run when a signing secret is supplied
// (`opts.signingSecret`) — see signature.ts's header for why LPP v1 treats
// this secret as out-of-band-provisioned rather than host-delivered. A bare
// `pnpm lpp:conform <url>` against a stranger's plugin has no way to learn
// that secret, so this suite degrades to a single `warn` explaining how to
// supply one (`--secret <hex>`) rather than failing the whole run.

import { randomUUID } from "node:crypto";
import type { LppEventSubscriberCapability } from "../capabilities/index.js";
import { LPP_SIGNATURE_HEADER, signLppBatch } from "../signature.js";
import { LPP_CONFIG_HEADER, encodeLppConfigHeaderValue, encodeLppSecretHeaderValue, lppSecretHeaderName } from "../headers.js";
import { lppConformRequest, type LppConformFetch } from "./http.js";
import type { LppCheckResult, LppSuiteReport } from "./types.js";

export interface EventSubscriberSuiteOptions extends LppConformFetch {
  nowMs: number;
  signingSecret?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  replayWindowMs?: number;
}

function buildTestBatch(capability: LppEventSubscriberCapability, nowMs: number) {
  return {
    batchId: randomUUID(),
    events: [
      {
        id: randomUUID(),
        type: capability.eventTypes[0] ?? "item.added",
        occurredAtMs: nowMs,
        payload: { conformanceProbe: true },
      },
    ],
    gapReport: null,
  };
}

function deliveryHeaders(opts: EventSubscriberSuiteOptions, signatureHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [LPP_SIGNATURE_HEADER]: signatureHeader,
  };
  if (opts.config) headers[LPP_CONFIG_HEADER] = encodeLppConfigHeaderValue(opts.config);
  if (opts.secrets) {
    for (const [field, value] of Object.entries(opts.secrets)) {
      headers[lppSecretHeaderName(field)] = encodeLppSecretHeaderValue(value);
    }
  }
  return headers;
}

export async function runEventSubscriberSuite(
  baseUrl: string,
  capability: LppEventSubscriberCapability,
  opts: EventSubscriberSuiteOptions,
): Promise<LppSuiteReport> {
  const checks: LppCheckResult[] = [];
  const deliveryUrl = new URL(capability.delivery.endpoint, baseUrl).toString();

  if (!opts.signingSecret) {
    checks.push({
      id: "event-subscriber.signature.skipped",
      description: "signed delivery checks require a shared signing secret",
      severity: "warn",
      detail: "no signing secret supplied — pass one via the CLI's --secret <hex> flag or runLppConformance({ signingSecret })",
    });
    return { suite: "event-subscriber", checks };
  }

  const batch = buildTestBatch(capability, opts.nowMs);
  const rawBody = JSON.stringify(batch);

  // ---- valid signature: MUST 2xx ------------------------------------------
  try {
    const validSig = signLppBatch(opts.signingSecret, opts.nowMs, rawBody);
    const res = await lppConformRequest(
      deliveryUrl,
      { method: "POST", headers: deliveryHeaders(opts, validSig), body: rawBody },
      opts,
    );
    checks.push({
      id: "event-subscriber.delivery.validSignature",
      description: "a batch with a valid signature is acknowledged (2xx)",
      severity: res.status >= 200 && res.status < 300 ? "pass" : "fail",
      detail: `HTTP ${res.status}`,
    });
  } catch (err) {
    checks.push({ id: "event-subscriber.delivery.validSignature", description: "a batch with a valid signature is acknowledged (2xx)", severity: "fail", detail: String(err) });
  }

  // ---- tampered body: SHOULD reject ----------------------------------------
  try {
    const validSig = signLppBatch(opts.signingSecret, opts.nowMs, rawBody);
    const tamperedBody = JSON.stringify({ ...batch, events: [{ ...batch.events[0], type: "tampered.event" }] });
    const res = await lppConformRequest(
      deliveryUrl,
      { method: "POST", headers: deliveryHeaders(opts, validSig), body: tamperedBody },
      opts,
    );
    const rejected = res.status < 200 || res.status >= 300;
    checks.push({
      id: "event-subscriber.delivery.tamperedBody",
      description: "a tampered batch body (signature no longer matches) SHOULD be rejected",
      severity: rejected ? "pass" : "warn",
      detail: `HTTP ${res.status}${rejected ? "" : " — plugin acked a tampered body; recommended to verify the signature before acking"}`,
    });
  } catch (err) {
    checks.push({ id: "event-subscriber.delivery.tamperedBody", description: "a tampered batch body (signature no longer matches) SHOULD be rejected", severity: "warn", detail: String(err) });
  }

  // ---- stale timestamp: SHOULD reject --------------------------------------
  try {
    const replayWindowMs = opts.replayWindowMs ?? 5 * 60_000;
    const staleTimestampMs = opts.nowMs - replayWindowMs * 10;
    const staleSig = signLppBatch(opts.signingSecret, staleTimestampMs, rawBody);
    const res = await lppConformRequest(
      deliveryUrl,
      { method: "POST", headers: deliveryHeaders(opts, staleSig), body: rawBody },
      opts,
    );
    const rejected = res.status < 200 || res.status >= 300;
    checks.push({
      id: "event-subscriber.delivery.staleTimestamp",
      description: "a validly-signed but stale-timestamped batch SHOULD be rejected (replay-window enforcement)",
      severity: rejected ? "pass" : "warn",
      detail: `HTTP ${res.status}${rejected ? "" : " — plugin acked a batch outside the replay window"}`,
    });
  } catch (err) {
    checks.push({ id: "event-subscriber.delivery.staleTimestamp", description: "a validly-signed but stale-timestamped batch SHOULD be rejected (replay-window enforcement)", severity: "warn", detail: String(err) });
  }

  return { suite: "event-subscriber", checks };
}
