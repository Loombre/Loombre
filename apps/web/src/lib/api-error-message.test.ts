// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-error-message.test.ts
//
// browser-admin-F5: every UI error surface rendered only the RFC 9457
// problem `title` — the generic, status-shaped word ("Conflict",
// "Unprocessable Entity") — and dropped `detail`, the one sentence the
// server wrote about THIS occurrence. Two layers had to hold for that to
// stop happening, and both are pinned here:
//
//   1. `apiErrorMessage` (the shared error-surface helper every catch
//      should route through) is detail-first.
//   2. `LoombreApiError.message` itself carries the detail, so the many
//      surfaces that still render a bare `err.message` — and any future
//      one written without thinking about it — are right by default.
//
// (2) belongs to packages/sdk, whose own `test` script is type-level only
// (`tsc -p tsconfig.test.json`; no vitest runner, and adding one would
// mean a devDependency + lockfile churn for a four-line class). apps/web
// is the SDK's only runtime consumer and already imports the real class in
// its specs (app/reset/[token]/ResetPasswordScreen.test.tsx), so the
// runtime guard lives here, against the built `@loombre/sdk` entry point.

import { describe, expect, it } from "vitest";
import { LoombreApiError } from "@loombre/sdk";
import { apiErrorCopy, apiErrorMessage, isApiProblem } from "./api-error-message.js";

const CONFLICT_DETAIL = "A user with this email address already exists.";

describe("apiErrorMessage — RFC 9457 detail-first", () => {
  it("prefers the problem detail over the title-level message", () => {
    const err = Object.assign(new Error("Conflict"), {
      problem: { type: "about:blank", title: "Conflict", status: 409, detail: CONFLICT_DETAIL },
    });
    expect(apiErrorMessage(err, "Failed to update user.")).toBe(CONFLICT_DETAIL);
  });

  it("falls back to the error message when the problem carries no detail", () => {
    const err = Object.assign(new Error("Conflict"), { problem: { title: "Conflict", status: 409 } });
    expect(apiErrorMessage(err, "Failed to update user.")).toBe("Conflict");
  });

  it("falls back to the caller's sentence for a thrown non-error", () => {
    expect(apiErrorMessage("boom", "Failed to update user.")).toBe("Failed to update user.");
  });
});

describe("LoombreApiError — Error.message carries the problem detail", () => {
  it("uses `detail` (the occurrence-specific sentence), not the generic `title`", () => {
    const err = new LoombreApiError(409, {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: CONFLICT_DETAIL,
    });
    expect(err.message).toBe(CONFLICT_DETAIL);
    // The regression this test exists for: modals rendered exactly the
    // word "Conflict" and nothing else.
    expect(err.message).not.toBe("Conflict");
  });

  it("still falls back to the title when the server sent no detail", () => {
    expect(new LoombreApiError(429, { title: "Too many attempts." }).message).toBe("Too many attempts.");
  });

  it("treats an empty-string detail as absent", () => {
    expect(new LoombreApiError(422, { title: "Unprocessable Entity", detail: "" }).message).toBe(
      "Unprocessable Entity",
    );
  });

  it("falls back to a status sentence when the body is not a problem document at all", () => {
    expect(new LoombreApiError(502, null).message).toBe("Request failed with status 502");
  });

  it("keeps the whole problem document reachable on `.problem` and the status on `.status`", () => {
    const problem = { title: "Conflict", detail: CONFLICT_DETAIL };
    const err = new LoombreApiError(409, problem);
    expect(err.problem).toBe(problem);
    expect(err.status).toBe(409);
    expect(err.name).toBe("LoombreApiError");
  });

  it("is routed correctly by apiErrorMessage — the helper and the class agree", () => {
    const err = new LoombreApiError(422, {
      title: "Unprocessable Entity",
      detail: "Resume threshold must be below the segment-ahead target.",
    });
    expect(apiErrorMessage(err, "Failed to save this setting.")).toBe(
      "Resume threshold must be below the segment-ahead target.",
    );
  });
});

// d4-e6: the sweep of `err instanceof LoombreApiError ? err.message : …`
// found a second family of that idiom — catch blocks that branch on the
// class to choose between the server's sentence and "Could not reach the
// server". Those must NOT collapse into a bare apiErrorMessage call: a
// `fetch` rejection carries a browser string ("Failed to fetch") that
// apiErrorMessage would happily render as user copy. `isApiProblem` keeps
// the distinction and duck-types it.
describe("isApiProblem — did the server answer at all", () => {
  it("is true for a real LoombreApiError", () => {
    expect(isApiProblem(new LoombreApiError(409, { title: "Conflict", detail: CONFLICT_DETAIL }))).toBe(true);
  });

  it("is true for a duck-typed problem error — the case instanceof gets wrong", () => {
    const err = Object.assign(new Error("Conflict"), { status: 409, problem: { title: "Conflict" } });
    expect(isApiProblem(err)).toBe(true);
  });

  it("is true for a problem document with no status alongside it — still an answer", () => {
    expect(isApiProblem({ problem: { title: "Conflict", detail: CONFLICT_DETAIL } })).toBe(true);
  });

  it("is true for a status whose body was not a problem document (problem: null)", () => {
    const err = new LoombreApiError(502, null);
    expect(isApiProblem(err)).toBe(true);
    expect(apiErrorMessage(err, "unused")).toBe("Request failed with status 502");
  });

  it("is FALSE for a transport failure — the whole reason the branch exists", () => {
    // What `fetch` rejects with when the host is unreachable. Rendering its
    // `.message` would tell the viewer "Failed to fetch".
    expect(isApiProblem(new TypeError("Failed to fetch"))).toBe(false);
    expect(isApiProblem(new Error("network down"))).toBe(false);
  });

  it("is FALSE for a thrown non-object and for null", () => {
    expect(isApiProblem("boom")).toBe(false);
    expect(isApiProblem(null)).toBe(false);
    expect(isApiProblem(undefined)).toBe(false);
  });
});

// The sweep's actual replacement for `instanceof LoombreApiError ?
// err.message : fallback`. Same two branches as the idiom it replaces —
// which is the point: routing those catches through `apiErrorMessage`
// alone fixes the class check and silently breaks the copy, because a
// `fetch` rejection's `.message` ("Failed to fetch") would become UI text
// where the surface's own sentence belongs.
describe("apiErrorCopy — the server's sentence, or the caller's", () => {
  it("prefers the problem detail when the server answered", () => {
    const err = new LoombreApiError(409, { title: "Conflict", detail: CONFLICT_DETAIL });
    expect(apiErrorCopy(err, "Failed to update user.")).toBe(CONFLICT_DETAIL);
  });

  it("reaches the detail through a duck-typed error — what instanceof got wrong", () => {
    const err = Object.assign(new Error("Conflict"), {
      status: 409,
      problem: { title: "Conflict", detail: CONFLICT_DETAIL },
    });
    expect(apiErrorCopy(err, "Failed to update user.")).toBe(CONFLICT_DETAIL);
  });

  it("uses the title when the server answered without a detail", () => {
    expect(apiErrorCopy(new LoombreApiError(429, { title: "Too many attempts." }), "Failed.")).toBe(
      "Too many attempts.",
    );
  });

  it("returns the caller's sentence for a transport failure — never the raw fetch message", () => {
    expect(apiErrorCopy(new TypeError("Failed to fetch"), "Failed to load jobs.")).toBe("Failed to load jobs.");
    expect(apiErrorCopy(new Error("network down"), "Could not update watched status")).toBe(
      "Could not update watched status",
    );
  });

  it("returns the caller's sentence for a thrown non-error", () => {
    expect(apiErrorCopy("boom", "Failed to load settings.")).toBe("Failed to load settings.");
  });

  it("matches the idiom it replaced, branch for branch, on a real LoombreApiError", () => {
    // The old shape: `err instanceof LoombreApiError ? err.message : fallback`.
    for (const err of [
      new LoombreApiError(409, { title: "Conflict", detail: CONFLICT_DETAIL }),
      new LoombreApiError(429, { title: "Too many attempts." }),
      new LoombreApiError(502, null),
    ]) {
      expect(apiErrorCopy(err, "fallback")).toBe(err.message);
    }
    expect(apiErrorCopy(new Error("network down"), "fallback")).toBe("fallback");
  });
});
