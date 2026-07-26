// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/BootSplash.fixtures.test.tsx
//
// STATE.md "Blaze logo rollout" D6/G5 — Lane D's fixture-hygiene grep
// allowlists exactly this path for the reference splash's banned literal
// fixtures (design/blaze/assets/loombre-splash.html:34-36): the 0.9.2
// version string, the /MNT/MEDIA mount path, and the STREAM ENGINE/LIBRARY
// MOUNT lines have no real pre-auth data source (STATE.md G5) and must
// never appear verbatim in the rendered splash. Expressed as REGEXES, not
// plain substring checks, so a coincidental real value could never satisfy
// a "must not contain" assertion by sheer luck.
//
// Deliberately ALL banned-fixture negative assertions live in this one
// file, and ONLY here — nothing else in this lane's suite duplicates them
// (see BootSplash.test.tsx for everything else: render modes, the D9
// one-shot gate, reduced-motion/D4 CSS-source checks).
//
// One render, one test: BootSplash's module-level `booted` flag (D9) means
// a second render in this same file would return null — every assertion
// below runs against the single real mount.

import { describe, expect, it } from "vitest";
import { BootSplash, __resetBootSplashForTests } from "./BootSplash.js";
import { getBootLogLines } from "./boot-log.js";
import { APP_VERSION } from "../../lib/app-version.js";
import { renderIntoBody } from "../ui/test-render.js";

describe("BootSplash — banned reference fixtures (D6/G5)", () => {
  // Moved here from boot-log.test.ts at W1 integration: this file is the
  // ONE brand:fixture-strings allowlist entry (G14) — the line-level
  // assertions live here too, not only the rendered-splash ones. Pure
  // function call, no render — the single-mount constraint below is safe.
  it("getBootLogLines never emits the reference's banned fixture values", () => {
    const lines = getBootLogLines({ serverUrl: "https://loombre.local:3001", hasStoredSession: true });
    const rendered = JSON.stringify(lines);
    expect(rendered).not.toMatch(/0\.9\.2/);
    expect(rendered).not.toMatch(/\/MNT\/MEDIA/i);
    expect(rendered).not.toMatch(/STREAM ENGINE/i);
    expect(rendered).not.toMatch(/LIBRARY MOUNT/i);
  });

  it("never renders the reference's fixture literals, and does render the real APP_VERSION", () => {
    __resetBootSplashForTests();
    const view = renderIntoBody(<BootSplash />);
    const text = view.container.textContent ?? "";

    // Banned fixtures — design/blaze/assets/loombre-splash.html:34-36.
    expect(text).not.toMatch(/0\.9\.2/);
    expect(text).not.toMatch(/\/MNT\/MEDIA/i);
    expect(text).not.toMatch(/STREAM ENGINE/i);
    expect(text).not.toMatch(/LIBRARY MOUNT/i);

    // Real client boot state IS rendered (G5) — not merely "not a fixture".
    expect(text).toContain(APP_VERSION);

    view.unmount();
  });
});
