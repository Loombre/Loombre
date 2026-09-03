// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-client.ts
//
// Wires the generated @loombre/sdk LoombreClient to the AuthStore: token
// injection via getAccessToken, plus a reactive 401 retry (the store's
// handleUnauthorized() is itself single-flight — see auth-store.ts).
//
// The retry is NOT unconditional: credential-validation endpoints answer
// 401 to mean "the secret you just sent is wrong", where refreshing and
// resending is useless and harmful. shouldRetryAfterUnauthorized()
// (./credential-endpoints.ts — its own module because this file is
// module-mocked wholesale by dozens of component tests) owns that call.
//
// RE-EXPORT TRAP (pinned by api-client.reexport.test.ts): LoombreApiError
// is re-exported at the bottom with the `export { … } from` form, NOT
// `import { X }; export { X }`. Under vitest, @vitest/mocker decides whether
// to rewrite a module's static imports into dynamic bindings with a raw
// text regex over the WHOLE source — comments included — that matches a
// vi.mock / vi.hoisted call together with its opening paren. When it fires
// it rewrites identifier references but not `export { name }` specifiers,
// so an import-then-export of an imported binding is left pointing at a
// local that no longer exists and resolves to `undefined` in every test
// that does not mock this module wholesale. This header once carried the
// trigger text itself. Keep both rules: (1) re-export imported bindings
// with `export { … } from`, and (2) keep the trigger text out of this file.
// The test asserts both. Production (Next/webpack) is unaffected — this is
// a vitest-pipeline artifact — but the class identity the test pins is a
// real production invariant: `instanceof LoombreApiError` across the
// api-client boundary needs the ONE class the SDK throws.

import {
  LoombreApiError,
  LoombreClient,
  type HttpMethod,
  type OperationFor,
  type PathsWithMethod,
  type RequestOptions,
  type SuccessResponseFor,
} from "@loombre/sdk";
import { getAuthStore } from "./auth-store.js";
import { shouldRetryAfterUnauthorized } from "./credential-endpoints.js";

// NOTE: packages/contract/openapi.yaml declares `servers: [{ url: "/v1" }]`,
// but the actual NestJS app (apps/server/src/main.ts) never calls
// `setGlobalPrefix` — every controller is mounted at its bare path (e.g.
// `POST /auth/login`, confirmed by apps/server/test/auth.e2e.spec.ts hitting
// `/auth/login` directly, and by AuthGuard's PUBLIC_ROUTES matching
// `req.path` with no prefix). Tested server behavior wins over the
// contract's aspirational `servers` entry (CLAUDE.md invariant 1:
// "Controllers conform (tested)") — so the client talks to the bare origin,
// no `/v1` segment appended.

let cached: { baseUrl: string; client: LoombreClient } | undefined;

/** The shared, auth-aware client — base URL follows the store's current
 *  serverUrl (set once at login / onboarding-lite). */
export function getClient(): LoombreClient {
  const store = getAuthStore();
  const baseUrl = store.getSnapshot().serverUrl;
  if (!cached || cached.baseUrl !== baseUrl) {
    cached = {
      baseUrl,
      client: new LoombreClient({
        baseUrl: baseUrl.replace(/\/$/, ""),
        getAccessToken: store.getAccessToken,
      }),
    };
  }
  return cached.client;
}

/** GET wrapper with one reactive-401 retry: on 401 it awaits the (single-
 *  flight) store refresh once, then retries the exact same request. A
 *  second 401 after a successful-looking refresh is treated as a hard
 *  auth failure and rethrown — it never retries a second time (that would
 *  risk resending an already-rotated refresh token). */
export async function apiGet<P extends PathsWithMethod<"get">>(
  path: P,
  options?: RequestOptions<OperationFor<P, "get">>,
): Promise<SuccessResponseFor<OperationFor<P, "get">>> {
  const store = getAuthStore();
  try {
    return await getClient().get(path, options);
  } catch (error) {
    if (
      error instanceof LoombreApiError &&
      error.status === 401 &&
      shouldRetryAfterUnauthorized("GET", path, error)
    ) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().get(path, options);
    }
    throw error;
  }
}

/** POST wrapper, same reactive-401 retry as apiGet. Not used by
 *  login/refresh/logout themselves (those are public routes hit directly
 *  via getClient().post so a stale cached access token is never attached). */
export async function apiPost<P extends PathsWithMethod<"post">>(
  path: P,
  options?: RequestOptions<OperationFor<P, "post">>,
): Promise<SuccessResponseFor<OperationFor<P, "post">>> {
  const store = getAuthStore();
  try {
    return await getClient().post(path, options);
  } catch (error) {
    if (
      error instanceof LoombreApiError &&
      error.status === 401 &&
      shouldRetryAfterUnauthorized("POST", path, error)
    ) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().post(path, options);
    }
    throw error;
  }
}

/** PUT wrapper, same reactive-401 retry as apiGet/apiPost. */
export async function apiPut<P extends PathsWithMethod<"put">>(
  path: P,
  options?: RequestOptions<OperationFor<P, "put">>,
): Promise<SuccessResponseFor<OperationFor<P, "put">>> {
  const store = getAuthStore();
  try {
    return await getClient().put(path, options);
  } catch (error) {
    if (
      error instanceof LoombreApiError &&
      error.status === 401 &&
      shouldRetryAfterUnauthorized("PUT", path, error)
    ) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().put(path, options);
    }
    throw error;
  }
}

/** PATCH wrapper, same reactive-401 retry as apiGet/apiPost. */
export async function apiPatch<P extends PathsWithMethod<"patch">>(
  path: P,
  options?: RequestOptions<OperationFor<P, "patch">>,
): Promise<SuccessResponseFor<OperationFor<P, "patch">>> {
  const store = getAuthStore();
  try {
    return await getClient().patch(path, options);
  } catch (error) {
    if (
      error instanceof LoombreApiError &&
      error.status === 401 &&
      shouldRetryAfterUnauthorized("PATCH", path, error)
    ) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().patch(path, options);
    }
    throw error;
  }
}

/** DELETE wrapper, same reactive-401 retry as apiGet/apiPost. */
export async function apiDelete<P extends PathsWithMethod<"delete">>(
  path: P,
  options?: RequestOptions<OperationFor<P, "delete">>,
): Promise<SuccessResponseFor<OperationFor<P, "delete">>> {
  const store = getAuthStore();
  try {
    return await getClient().delete(path, options);
  } catch (error) {
    if (
      error instanceof LoombreApiError &&
      error.status === 401 &&
      shouldRetryAfterUnauthorized("DELETE", path, error)
    ) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().delete(path, options);
    }
    throw error;
  }
}

// apiErrorMessage moved to ./api-error-message.ts — see that file's header
// for why it must NOT live behind the widely-mocked api-client surface.

// `export { … } from` on purpose — see the RE-EXPORT TRAP note in the header.
export { LoombreApiError } from "@loombre/sdk";
export type { HttpMethod };
