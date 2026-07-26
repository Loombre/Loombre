// SPDX-License-Identifier: AGPL-3.0-only
// Hand-authored, stable. Do not regenerate — only ./generated/* is codegen
// output. This is a thin typed fetch wrapper over the shapes produced by
// openapi-typescript from packages/contract/openapi.yaml.

import type { paths } from "./generated/types.js";

/** HTTP methods that appear as keys on a `paths[P]` entry. */
export type HttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch"
  | "trace";

/** Every path that declares at least one operation for method `M`. */
export type PathsWithMethod<M extends HttpMethod> = {
  [P in keyof paths]: M extends keyof paths[P] ? P : never;
}[keyof paths];

/** The operation object (parameters/requestBody/responses) for path `P`, method `M`. */
export type OperationFor<
  P extends keyof paths,
  M extends HttpMethod,
> = M extends keyof paths[P] ? paths[P][M] : never;

type MaybeParameters<Op> = Op extends { parameters: infer Params }
  ? Params
  : Record<string, never>;

type JsonContent<T> = T extends { content: { "application/json": infer C } }
  ? C
  : never;

/** JSON request body type for an operation, or `never` if it takes none. */
export type RequestBodyFor<Op> = Op extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;

/** True when a response-map key (string OR number — openapi-typescript emits
 *  numeric literal keys like `200` for status codes, which never match a
 *  `\`2${string}\`` template-literal pattern directly since template
 *  literal types only match `string`-typed members) denotes a 2xx status. */
type IsSuccessStatus<S> = S extends string
  ? S extends `2${string}`
    ? true
    : false
  : S extends number
    ? `${S}` extends `2${string}`
      ? true
      : false
    : false;

/** Union of JSON response bodies across every 2xx response for an operation. */
export type SuccessResponseFor<Op> = Op extends { responses: infer R }
  ? {
      [S in keyof R]: IsSuccessStatus<S> extends true ? JsonContent<R[S]> : never;
    }[keyof R]
  : never;

/** Options accepted by `LoombreClient#request` for a given operation. */
export interface RequestOptions<Op> {
  params?: MaybeParameters<Op>;
  body?: RequestBodyFor<Op>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface LoombreClientOptions {
  /** Origin + optional path prefix, e.g. `https://loombre.local` (the `/v1` prefix is added by the server per components; pass it here too if your deployment serves the API from a sub-path). */
  baseUrl: string;
  /** Called before every request; return `null`/`undefined` to send no Authorization header (e.g. login/refresh). */
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** Override for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export class LoombreApiError extends Error {
  readonly status: number;
  readonly problem: unknown;

  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `Request failed with status ${status}`;
    super(title);
    this.name = "LoombreApiError";
    this.status = status;
    this.problem = problem;
  }
}

function buildUrl(
  baseUrl: string,
  rawPath: string,
  params?: { path?: Record<string, unknown>; query?: Record<string, unknown> },
): string {
  let resolvedPath = rawPath;
  const pathParams = params?.path ?? {};
  for (const [key, value] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replace(
      `{${key}}`,
      encodeURIComponent(String(value)),
    );
  }

  const url = new URL(
    resolvedPath.replace(/^\//, ""),
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );

  const queryParams = params?.query ?? {};
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

/**
 * Thin typed fetch wrapper around the Loombre API. One instance per
 * (baseUrl, auth context). Constructed once per client app; every typed
 * helper below funnels through `request()`, which is the only place that
 * touches `fetch` directly.
 */
export class LoombreClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: LoombreClientOptions["getAccessToken"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: LoombreClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getAccessToken = options.getAccessToken;
    // Bound to globalThis: browsers' window.fetch throws "Illegal
    // invocation" when called with any other receiver, and storing it on
    // `this.fetchImpl` would otherwise invoke it with the client instance
    // as `this`. (Node's undici fetch is receiver-insensitive, which is
    // why only real browsers catch this.)
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  /**
   * Generic typed request. `path` and `method` are constrained to the
   * operations declared in openapi.yaml (via the generated `paths` type),
   * so a typo'd path or an unsupported method is a compile error.
   */
  async request<P extends keyof paths, M extends HttpMethod>(
    method: M,
    path: P & PathsWithMethod<M>,
    options?: RequestOptions<OperationFor<P, M>>,
  ): Promise<SuccessResponseFor<OperationFor<P, M>>> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options?.headers ?? {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const url = buildUrl(
      this.baseUrl,
      path as string,
      options?.params as
        | { path?: Record<string, unknown>; query?: Record<string, unknown> }
        | undefined,
    );

    const response = await this.fetchImpl(url, {
      method: method.toUpperCase(),
      headers,
      body,
      signal: options?.signal,
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const problem = contentType.includes("json")
        ? await response.json().catch(() => undefined)
        : await response.text().catch(() => undefined);
      throw new LoombreApiError(response.status, problem);
    }

    if (response.status === 204) {
      return undefined as SuccessResponseFor<OperationFor<P, M>>;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      return (await response.json()) as SuccessResponseFor<OperationFor<P, M>>;
    }
    return (await response.text()) as unknown as SuccessResponseFor<
      OperationFor<P, M>
    >;
  }

  get<P extends PathsWithMethod<"get">>(
    path: P,
    options?: RequestOptions<OperationFor<P, "get">>,
  ): Promise<SuccessResponseFor<OperationFor<P, "get">>> {
    return this.request("get", path, options);
  }

  post<P extends PathsWithMethod<"post">>(
    path: P,
    options?: RequestOptions<OperationFor<P, "post">>,
  ): Promise<SuccessResponseFor<OperationFor<P, "post">>> {
    return this.request("post", path, options);
  }

  put<P extends PathsWithMethod<"put">>(
    path: P,
    options?: RequestOptions<OperationFor<P, "put">>,
  ): Promise<SuccessResponseFor<OperationFor<P, "put">>> {
    return this.request("put", path, options);
  }

  patch<P extends PathsWithMethod<"patch">>(
    path: P,
    options?: RequestOptions<OperationFor<P, "patch">>,
  ): Promise<SuccessResponseFor<OperationFor<P, "patch">>> {
    return this.request("patch", path, options);
  }

  delete<P extends PathsWithMethod<"delete">>(
    path: P,
    options?: RequestOptions<OperationFor<P, "delete">>,
  ): Promise<SuccessResponseFor<OperationFor<P, "delete">>> {
    return this.request("delete", path, options);
  }
}
