// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/problem.ts
//
// RFC 9457 problem+json (CLAUDE.md invariant 5), mirroring the shape of
// apps/server/src/gateway/problem.exception.ts's Problem schema field for
// field (packages/contract/openapi.yaml `Problem`: required [title, status],
// everything else optional, extension members additive). A plugin's error
// responses use this SAME shape so a host adapter (W2) can render a plugin
// failure the same way it renders any other Loombre error — but plugins are
// third-party, out-of-process services (C1), not part of the main API
// surface, so LPP error `type` values live under their OWN URN namespace
// (`urn:loombre:lpp:problem:*`) rather than the main API's
// `urn:loombre:problem:*` catalog, keeping the two catalogs independently
// extensible.

import { z } from "zod";

export const LppProblemSchema = z
  .object({
    type: z.string().min(1).default("about:blank"),
    title: z.string().min(1),
    status: z.number().int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string().optional(),
  })
  // RFC 9457 problem details are additive — an unrecognized extension
  // member is not a protocol violation (mirrors packages/contract's
  // `additionalProperties: true` on Problem).
  .passthrough();

export type LppProblem = z.infer<typeof LppProblemSchema>;

export const LPP_PROBLEM_CONTENT_TYPE = "application/problem+json";

/** LPP's own problem `type` catalog (additive; new members are new URNs,
 *  never a change to an existing one — same additive-only discipline as
 *  every other LPP wire shape, C8). */
export const LPP_PROBLEM_TYPES = {
  /** Malformed/schema-invalid request body to any `/lpp/provider/*` or
   *  `/lpp/events` endpoint. */
  validation: "urn:loombre:lpp:problem:validation",
  /** A `ProviderRef` (details/images request) the plugin does not
   *  recognize. */
  notFound: "urn:loombre:lpp:problem:not-found",
  /** `X-LPP-Signature` missing, malformed, or not matching the plugin's
   *  registered secret (signature.ts). */
  invalidSignature: "urn:loombre:lpp:problem:invalid-signature",
  /** Signature valid but `t=` falls outside the replay window
   *  (signature.ts's `LPP_DEFAULT_REPLAY_WINDOW_MS`). */
  staleTimestamp: "urn:loombre:lpp:problem:stale-timestamp",
} as const;

export function lppProblem(params: {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
}): LppProblem {
  return {
    type: params.type,
    title: params.title,
    status: params.status,
    ...(params.detail !== undefined ? { detail: params.detail } : {}),
    ...(params.instance !== undefined ? { instance: params.instance } : {}),
    ...(params.code !== undefined ? { code: params.code } : {}),
  };
}
