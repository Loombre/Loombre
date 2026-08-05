// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-client.ts
//
// Wires the generated @loombre/sdk LoombreClient to the AuthStore: token
// injection via getAccessToken, plus a reactive 401 retry (the store's
// handleUnauthorized() is itself single-flight — see auth-store.ts).

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
    if (error instanceof LoombreApiError && error.status === 401) {
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
    if (error instanceof LoombreApiError && error.status === 401) {
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
    if (error instanceof LoombreApiError && error.status === 401) {
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
    if (error instanceof LoombreApiError && error.status === 401) {
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
    if (error instanceof LoombreApiError && error.status === 401) {
      const token = await store.handleUnauthorized();
      if (!token) throw error;
      return getClient().delete(path, options);
    }
    throw error;
  }
}

// apiErrorMessage moved to ./api-error-message.ts — see that file's header
// for why it must NOT live behind the widely-mocked api-client surface.

export { LoombreApiError };
export type { HttpMethod };
