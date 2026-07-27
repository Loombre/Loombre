// SPDX-License-Identifier: AGPL-3.0-only
// Type-level regression tests for the hand-authored wrapper in src/client.ts.
// Checked by `pnpm --filter @loombre/sdk test` (tsc -p tsconfig.test.json);
// there is nothing to execute at runtime.

import type {
  HttpMethod,
  OperationFor,
  SuccessResponseFor,
  UndecodableResponseBody,
} from "../src/client.js";
import type { components, paths } from "../src/generated/types.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

type Success<P extends keyof paths, M extends HttpMethod> = SuccessResponseFor<
  OperationFor<P, M>
>;

// application/json: the declared schema, unchanged.
type _Json = Expect<
  Equal<Success<"/system/info", "get">, components["schemas"]["SystemInfo"]>
>;

// text/plain — decoded by request()'s response.text() fallback, so `string`,
// not `never` (the admin crash-file viewer consumes this).
type _TextPlain = Expect<Equal<Success<"/admin/crash-files/{name}", "get">, string>>;

// text/vtt and application/vnd.apple.mpegurl are textual too.
type _TextVtt = Expect<
  Equal<Success<"/playback/sessions/{id}/subtitles/{file}", "get">, string>
>;
type _Mpegurl = Expect<
  Equal<Success<"/playback/sessions/{id}/hls/media.m3u8", "get">, string>
>;

// Binary bodies have no decode path through request(); they must surface as
// the branded marker so a call site is a compile error, not silently `never`.
type _Image = Expect<
  Equal<Success<"/images/{entityType}/{id}/{kind}", "get">, UndecodableResponseBody>
>;
type _OctetStream = Expect<
  Equal<Success<"/playback/sessions/{id}/hls/{file}", "get">, UndecodableResponseBody>
>;

// No 2xx-with-content operation may collapse to `never`.
type IsNever<T> = [T] extends [never] ? true : false;
type _NoneNever = Expect<
  Equal<
    | IsNever<Success<"/system/info", "get">>
    | IsNever<Success<"/admin/crash-files/{name}", "get">>
    | IsNever<Success<"/images/{entityType}/{id}/{kind}", "get">>
    | IsNever<Success<"/playback/sessions/{id}/hls/{file}", "get">>
    | IsNever<Success<"/playback/sessions/{id}/subtitles/{file}", "get">>,
    false
  >
>;

// The marker is not assignable to the primitives a caller would reach for —
// that is what turns a binary operation into a compile error.
type _MarkerNotString = Expect<
  Equal<UndecodableResponseBody extends string ? true : false, false>
>;
