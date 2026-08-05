// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/server/src/common/limit-param.ts
//
// Review finding R-F9 (repo-wide): every cursor-list controller parsed
// `?limit` leniently (non-numeric/non-positive → ignored, the query
// layer's default applies) but NONE enforced the contract's `maximum` —
// `?limit=1000000` sailed straight through to the query layer. One shared
// clamp, keeping the established lenient posture: malformed values are
// still ignored rather than 422'd (matching how every other malformed
// list param is parsed across these controllers), and oversized values
// are CLAMPED to the contract maximum rather than rejected.

/** components/parameters/Limit's `maximum` (packages/contract/openapi.yaml)
 *  — the one shared page-size ceiling every cursor-list operation
 *  references. */
export const LIMIT_PARAM_MAX = 200;

export function parseLimitParam(value: unknown, max: number = LIMIT_PARAM_MAX): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, max);
}
