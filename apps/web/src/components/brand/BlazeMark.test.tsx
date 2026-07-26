// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/BlazeMark.test.tsx
//
// STATE.md "Blaze logo rollout" W0, feedback-loop-first (A.1/A.2): written
// and run RED (BlazeMark.tsx did not exist yet — module-not-found) before
// the component was implemented, so these two locked decisions are
// enforced mechanically, not just eyeballed:
//   D5 — below the 24px size gate, only the flat variant may render, and a
//        dev-mode console.warn documents the downgrade (suppressed when
//        NODE_ENV === "production").
//   D3 — static (default) mode renders ONE evenodd path (outer+core
//        combined — a true cut-out on any background); animated mode
//        renders TWO paths (outer + a core path filled with the `surface`
//        prop), the structure Lanes B/C (splash, spinner) hang their own
//        keyframe classes on (design/blaze/assets/loombre-splash.html's
//        rig/blaze/core groups).

import { afterEach, describe, expect, it, vi } from "vitest";
import { BLAZE_COMBINED_D, BLAZE_CORE_D, BLAZE_OUTER_D } from "./blaze-paths.js";
import { BLAZE_SIZE_GATE_PX, BlazeMark } from "./BlazeMark.js";
import { renderIntoBody } from "../ui/test-render.js";

// Filters to the mark's own rendered geometry paths, excluding the
// scanline variant's <clipPath><path> (clip geometry, not a drawn mark
// part) — see BlazeMark.tsx for why that distinction is tagged in the DOM.
function markParts(container: HTMLElement): HTMLElement[] {
  const svg = container.querySelector("svg")!;
  return Array.from(svg.querySelectorAll("[data-mark-part]"));
}

describe("BlazeMark — size gate (D5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forces the flat fill below the 24px gate and warns in dev mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = renderIntoBody(<BlazeMark variant="gradient" size={16} />);
    const path = markParts(view.container)[0]!;
    expect(path.getAttribute("fill")).toBe("var(--brand-amber)");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/BlazeMark/);
    view.unmount();
  });

  it("renders the gradient at 24px (the boundary itself is NOT below-gate) with no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = renderIntoBody(<BlazeMark variant="gradient" size={24} />);
    const path = markParts(view.container)[0]!;
    expect(path.getAttribute("fill")).toMatch(/^url\(#/);
    expect(warn).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not warn when the requested variant is already flat below the gate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = renderIntoBody(<BlazeMark variant="flat" size={16} />);
    expect(warn).not.toHaveBeenCalled();
    view.unmount();
  });

  it("suppresses the dev warning when NODE_ENV is production", () => {
    // process.env.NODE_ENV is `readonly` in Next's own global type
    // (next/types/global.d.ts) — vi.stubEnv is the vitest-supported way to
    // override it for a test without a direct (type-rejected) assignment.
    vi.stubEnv("NODE_ENV", "production");
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const view = renderIntoBody(<BlazeMark variant="gradient" size={16} />);
      expect(warn).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exposes the 24px threshold as a named constant", () => {
    expect(BLAZE_SIZE_GATE_PX).toBe(24);
  });
});

describe("BlazeMark — render modes (D3)", () => {
  it("static (default) mode renders exactly one evenodd path containing both subpaths", () => {
    const view = renderIntoBody(<BlazeMark variant="gradient" size={96} />);
    const parts = markParts(view.container);
    expect(parts.length).toBe(1);
    expect(parts[0]!.getAttribute("fill-rule")).toBe("evenodd");
    const d = parts[0]!.getAttribute("d");
    expect(d).toContain(BLAZE_OUTER_D);
    expect(d).toContain(BLAZE_CORE_D);
    expect(d).toBe(BLAZE_COMBINED_D);
    view.unmount();
  });

  it("animated mode renders exactly two paths, the core filled with the surface prop", () => {
    const view = renderIntoBody(<BlazeMark variant="gradient" size={96} animated surface="#123456" />);
    const parts = markParts(view.container);
    expect(parts.length).toBe(2);
    const outer = parts.find((p) => p.getAttribute("data-mark-part") === "outer")!;
    const core = parts.find((p) => p.getAttribute("data-mark-part") === "core")!;
    expect(outer.getAttribute("d")).toBe(BLAZE_OUTER_D);
    expect(core.getAttribute("d")).toBe(BLAZE_CORE_D);
    expect(core.getAttribute("fill")).toBe("#123456");
    view.unmount();
  });

  it("animated mode defaults the core surface fill to the splash background token", () => {
    const view = renderIntoBody(<BlazeMark variant="gradient" size={96} animated />);
    const core = markParts(view.container).find((p) => p.getAttribute("data-mark-part") === "core")!;
    expect(core.getAttribute("fill")).toBe("var(--color-bg-splash)");
    view.unmount();
  });

  it("animated mode exposes the rig/blaze animation-hook classes from the classNames prop", () => {
    const view = renderIntoBody(
      <BlazeMark
        variant="gradient"
        size={96}
        animated
        classNames={{ rig: "rig-class", blaze: "blaze-class", core: "core-class" }}
      />,
    );
    const svg = view.container.querySelector("svg")!;
    expect(svg.querySelector(".rig-class")).not.toBeNull();
    expect(svg.querySelector(".blaze-class")).not.toBeNull();
    expect(svg.querySelector(".core-class")).not.toBeNull();
    view.unmount();
  });
});

describe("BlazeMark — accessibility + variant fills", () => {
  it("is aria-hidden by default (decorative)", () => {
    const view = renderIntoBody(<BlazeMark size={96} />);
    expect(view.container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    view.unmount();
  });

  it("exposes role=img + aria-label when a label is given", () => {
    const view = renderIntoBody(<BlazeMark size={96} aria-label="Loombre" />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("false");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Loombre");
    view.unmount();
  });

  it("flat variant fills with the brand-fixed amber token, never --color-accent (G4)", () => {
    const view = renderIntoBody(<BlazeMark variant="flat" size={96} />);
    const fill = markParts(view.container)[0]!.getAttribute("fill");
    expect(fill).toBe("var(--brand-amber)");
    expect(fill).not.toContain("--color-accent");
    view.unmount();
  });

  it("scanline variant renders the pattern + clip defs, distinct from the gradient variant", () => {
    const view = renderIntoBody(<BlazeMark variant="scanline" size={96} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.querySelector("pattern")).not.toBeNull();
    expect(svg.querySelector("clipPath")).not.toBeNull();
    view.unmount();
  });

  it("gradient variant renders a linearGradient def, no pattern/clipPath", () => {
    const view = renderIntoBody(<BlazeMark variant="gradient" size={96} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.querySelector("linearGradient")).not.toBeNull();
    expect(svg.querySelector("pattern")).toBeNull();
    view.unmount();
  });

  it("size prop drives width/height while viewBox stays fixed at 0 0 96 96", () => {
    const view = renderIntoBody(<BlazeMark variant="flat" size={48} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.getAttribute("height")).toBe("48");
    expect(svg.getAttribute("viewBox")).toBe("0 0 96 96");
    view.unmount();
  });
});
