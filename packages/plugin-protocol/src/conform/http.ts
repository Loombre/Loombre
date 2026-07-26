// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/conform/http.ts
//
// Tiny fetch wrapper for the conformance suite. Uses the platform `fetch`
// (Node >=22, this repo's engines floor — root package.json) rather than
// adding an HTTP client dependency (zero-new-dependency rule). Every call
// carries an AbortController timeout: C6/C7 document that the HOST enforces
// timeout budgets on real plugin traffic, and this suite mirrors that
// discipline against whatever target URL it's pointed at so a hung plugin
// under test fails the run cleanly instead of hanging the CLI forever.

export const LPP_CONFORM_DEFAULT_TIMEOUT_MS = 10_000;

export interface LppHttpResponse {
  status: number;
  headers: Headers;
  bodyText: string;
}

export interface LppConformFetch {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function lppConformRequest(
  url: string,
  init: RequestInit,
  opts: LppConformFetch = {},
): Promise<LppHttpResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LPP_CONFORM_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    return { status: response.status, headers: response.headers, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
