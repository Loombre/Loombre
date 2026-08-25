// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/sdk/test/loombre-api-error.test.ts
//
// d3-e6: RUNTIME coverage for LoombreApiError's message precedence. Until
// this file existed the package's only `test` step was `tsc -p
// tsconfig.test.json` — type-level, with nothing to execute — so the
// behaviour every UI surface in apps/web depends on (`err.message` is the
// RFC 9457 `detail`, not the generic `title`) was guarded only indirectly,
// from apps/web's own specs, against the BUILT dist.
//
// The precedence itself is browser-admin-F5's fix (73eed8e): `title` is the
// generic summary of the problem TYPE ("Conflict"), `detail` is the sentence
// written about THIS occurrence ("A user with this email address already
// exists."). Building the message from the title threw away the only
// actionable half, leaving modals showing a bare status word.

import { describe, expect, it } from "vitest";
import { LoombreApiError } from "../src/client.js";

describe("LoombreApiError message precedence (RFC 9457, browser-admin-F5)", () => {
  it("prefers detail over title — the sentence about THIS occurrence wins", () => {
    const err = new LoombreApiError(409, {
      type: "urn:loombre:problem:conflict",
      title: "Conflict",
      status: 409,
      detail: "A user with this email address already exists.",
    });
    expect(err.message).toBe("A user with this email address already exists.");
  });

  it("falls back to title when detail is absent, empty, or not a string", () => {
    const base = { type: "urn:loombre:problem:conflict", title: "Conflict", status: 409 };
    expect(new LoombreApiError(409, base).message).toBe("Conflict");
    expect(new LoombreApiError(409, { ...base, detail: "" }).message).toBe("Conflict");
    expect(new LoombreApiError(409, { ...base, detail: null }).message).toBe("Conflict");
    expect(new LoombreApiError(409, { ...base, detail: 42 }).message).toBe("Conflict");
  });

  it("stringifies a non-string title rather than dropping the only half it has", () => {
    expect(new LoombreApiError(500, { title: 500 }).message).toBe("500");
  });

  it("falls back to a status sentence when the body is not a problem document at all", () => {
    expect(new LoombreApiError(502, undefined).message).toBe("Request failed with status 502");
    expect(new LoombreApiError(502, null).message).toBe("Request failed with status 502");
    expect(new LoombreApiError(502, "<html>Bad Gateway</html>").message).toBe("Request failed with status 502");
    expect(new LoombreApiError(502, {}).message).toBe("Request failed with status 502");
  });

  it("keeps status and the raw problem document verbatim for callers that need more than the message", () => {
    const problem = { type: "urn:loombre:problem:validation", title: "Unprocessable Entity", status: 422, errors: [{ field: "email" }] };
    const err = new LoombreApiError(422, problem);
    expect(err.status).toBe(422);
    expect(err.problem).toBe(problem);
  });

  it("is a real Error subclass named LoombreApiError — instanceof and .name both hold", () => {
    const err = new LoombreApiError(404, { title: "Not Found" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LoombreApiError);
    expect(err.name).toBe("LoombreApiError");
    expect(err.stack).toBeTypeOf("string");
  });
});
