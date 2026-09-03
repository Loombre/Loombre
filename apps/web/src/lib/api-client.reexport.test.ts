// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/api-client.reexport.test.ts
//
// Pins the identity of api-client.ts's re-exported LoombreApiError.
//
// Every consumer that writes `error instanceof LoombreApiError` after
// importing the class from "./api-client.js" depends on that binding being
// the ONE class @loombre/sdk throws. Two things can break it:
//
//   1. A genuine dual-instance regression — a second copy of the SDK class
//      reachable from the web app (a duplicated @loombre/sdk install, or a
//      re-export that constructs/wraps instead of forwarding). `instanceof`
//      across the boundary then fails in production, silently.
//   2. The vitest mock-hoisting trap (2026-09-03). @vitest/mocker decides
//      whether to rewrite a module's static imports into dynamic
//      `__vi_import_N__` bindings with a raw text regex over the WHOLE
//      source — comments included. When it fires, it rewrites identifier
//      references but NOT `export { name }` specifiers, so an
//      import-then-export re-export of an imported binding is left pointing
//      at a local that no longer exists and resolves to `undefined`. The
//      `export { name } from "…"` form has no local binding and survives.
//      api-client.ts's own header comment once carried the trigger text.
//
// This file deliberately does NOT vi.mock anything: it must observe the real
// module graph, because mocking api-client.ts wholesale is precisely what
// hid (2) from every other test in the suite.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoombreApiError as FromSdk } from "@loombre/sdk";
import { LoombreApiError as FromApiClient } from "./api-client.js";

describe("api-client.ts re-export of LoombreApiError", () => {
  it("forwards the SDK class itself — same reference, so instanceof works across the boundary", () => {
    expect(typeof FromApiClient).toBe("function");
    expect(Object.is(FromApiClient, FromSdk)).toBe(true);

    const thrown: unknown = new FromSdk(401, {
      type: "urn:loombre:problem:unauthenticated",
      title: "Unauthenticated",
      status: 401,
    });
    expect(thrown instanceof FromApiClient).toBe(true);
  });

  it("api-client.ts source never opts itself into vitest mock-hoisting", () => {
    // Mirrors @vitest/mocker's `regexpHoistable` (chunk-hoistMocks.js). A
    // match anywhere in the source — a comment is enough — makes the plugin
    // rewrite the module's imports; keep the trigger text out of a
    // production module that also re-exports an imported binding.
    const hoistTrigger = /\b(?:vi|vitest)\s*\.\s*(?:mock|unmock|hoisted|doMock|doUnmock)\s*\(/;
    // import.meta.dirname, not fileURLToPath(import.meta.url): under the
    // jsdom environment vitest serves modules from a non-file URL.
    const source = readFileSync(join(import.meta.dirname, "api-client.ts"), "utf8");
    expect(hoistTrigger.test(source)).toBe(false);
  });
});
