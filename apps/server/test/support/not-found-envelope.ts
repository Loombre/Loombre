// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/support/not-found-envelope.ts
//
// adi-F3 (QA 2026-08-21; owner ruling 2026-08-24). Five suites pin the
// "invisible == nonexistent" 404 posture on their own surface —
// conformance.spec.ts (setup/reset/probe), setup.e2e, invites.e2e,
// password-recovery.e2e, remote-probes.e2e — and each of them used to
// close with the same literal `{type:"about:blank", title:"Not Found",
// status:404}`. That literal is gone: the whole family now answers the
// COMPLETE not-found problem (`urn:loombre:problem:not-found`, a fixed
// generic `detail`, and `instance`), exactly like every contract-governed
// 404. These two assertions live here so the five copies cannot drift
// apart from one another, or from the finding's own regression net
// (apps/server/test/not-found-envelope.e2e.spec.ts).
//
// WHAT DID NOT CHANGE, and must not: the anti-enumeration invariant. FOR
// ANY GIVEN REQUEST PATH, a hidden/unentitled resource and a nonexistent
// route answer BYTE-IDENTICAL bodies. `instance` reflects only the
// requester's own path — never anything about what was or wasn't there —
// so the two helpers below split cleanly:
//   - same path  -> compare `.text` byte for byte (the strong form; see
//     not-found-envelope.e2e.spec.ts, which does this for every surface).
//   - different paths -> `expectSameNotFoundBodyApartFromInstance`, the
//     strongest statement available when the two probes cannot share a
//     URL, which is the case for every cross-path comparison below.

import { expect } from "vitest";

/** Asserted as LITERALS, never imported from apps/server/src — the point
 *  is to pin the WIRE shape, and importing it would make that vacuous. */
export const NOT_FOUND_PROBLEM_TYPE = "urn:loombre:problem:not-found";
export const NOT_FOUND_DETAIL = "Not found.";

/** Structural stand-in for supertest's Response — only what these read. */
export interface NotFoundProbe {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * The complete envelope every 404 in the enumeration-resistant family
 * carries. `instance` is passed in because it is the ONE member that
 * legitimately varies: the caller's own request path, collapsed to the
 * route template on the token-bearing routes (sanitize-instance.ts).
 */
export function expectSharedNotFoundProblem(res: NotFoundProbe, instance: string): Record<string, unknown> {
  expect(res.status, res.text).toBe(404);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  const body = JSON.parse(res.text) as Record<string, unknown>;
  expect(body["type"]).toBe(NOT_FOUND_PROBLEM_TYPE);
  expect(body["title"]).toBe("Not Found");
  expect(body["status"]).toBe(404);
  expect(body["detail"]).toBe(NOT_FOUND_DETAIL);
  expect(body["instance"]).toBe(instance);
  return body;
}

/**
 * Two 404s taken at DIFFERENT paths: same status, same content type, same
 * member set, and every member except `instance` identical. Anything that
 * varied with WHAT was probed (rather than with WHO probed and where)
 * would fail here.
 */
export function expectSameNotFoundBodyApartFromInstance(a: NotFoundProbe, b: NotFoundProbe): void {
  expect(a.status).toBe(b.status);
  expect(a.headers["content-type"]).toBe(b.headers["content-type"]);
  const parsed = [a, b].map((res) => JSON.parse(res.text) as Record<string, unknown>);
  expect(Object.keys(parsed[0]!).sort()).toEqual(Object.keys(parsed[1]!).sort());
  for (const body of parsed) delete body["instance"];
  expect(parsed[0]).toEqual(parsed[1]);
}
