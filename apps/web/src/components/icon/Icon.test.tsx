// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/icon/Icon.test.tsx
//
// Wave 2 L7 (U7): verifies the wrapper's two branches — a PhosphorIconName
// resolves to the custom path-data record (path/rect/text presence, the
// seek glyphs' baked-in numerals, fixed 1.55 stroke regardless of the
// `strokeWidth` prop) — and a LucideIcon component value falls through to
// lucide-react's own rendering, honoring `strokeWidth` (the one thing that
// tells the two branches apart in the rendered DOM, since both use the
// same 24x24 viewBox).

import { X } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon.js";
import { PHOSPHOR_ICONS } from "./phosphor-paths.js";
import { renderIntoBody } from "../ui/test-render.js";

describe("Icon — Phosphor custom glyphs (U7)", () => {
  it("renders every declared path/rect element for a stroke-variant glyph (home)", () => {
    const view = renderIntoBody(<Icon icon="home" />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBe(PHOSPHOR_ICONS.home.elements.length);
    view.unmount();
  });

  it("renders rect + path elements for a mixed glyph (lock)", () => {
    const view = renderIntoBody(<Icon icon="lock" />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.querySelectorAll("rect").length).toBe(1);
    expect(svg.querySelectorAll("path").length).toBe(1);
    view.unmount();
  });

  it("lock and unlock render distinct shackle paths (closed vs open)", () => {
    const lockView = renderIntoBody(<Icon icon="lock" />);
    const unlockView = renderIntoBody(<Icon icon="unlock" />);
    const lockD = lockView.container.querySelector("path")!.getAttribute("d");
    const unlockD = unlockView.container.querySelector("path")!.getAttribute("d");
    expect(lockD).not.toBe(unlockD);
    expect(lockD).toContain("V11"); // closed shackle returns to the body
    expect(unlockD).not.toContain("V11"); // open shackle does not
    lockView.unmount();
    unlockView.unmount();
  });

  it("renders fill-variant glyphs (play/pause) with fill:currentColor, stroke:none", () => {
    const view = renderIntoBody(<Icon icon="play" />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("stroke")).toBe("none");
    view.unmount();
  });

  it("seek glyphs bake the 15/30 numerals in as <text>, always filled regardless of glyph variant", () => {
    const backView = renderIntoBody(<Icon icon="seekBack15" />);
    const backText = backView.container.querySelector("text")!;
    expect(backText.textContent).toBe("15");
    expect(backText.getAttribute("fill")).toBe("currentColor");
    expect(backText.getAttribute("stroke")).toBe("none");
    backView.unmount();

    const forwardView = renderIntoBody(<Icon icon="seekForward30" />);
    const forwardText = forwardView.container.querySelector("text")!;
    expect(forwardText.textContent).toBe("30");
    forwardView.unmount();
  });

  it("Phosphor glyphs always render at the spec's 1.55 stroke width, ignoring the strokeWidth prop", () => {
    const view = renderIntoBody(<Icon icon="home" strokeWidth={4} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("1.55");
    view.unmount();
  });

  it("desktop nav size renders 17px, tab-bar/default renders 24px (README 'Icons')", () => {
    const navView = renderIntoBody(<Icon icon="home" size="nav" />);
    expect(navView.container.querySelector("svg")!.getAttribute("width")).toBe("17");
    navView.unmount();

    const defaultView = renderIntoBody(<Icon icon="home" />);
    expect(defaultView.container.querySelector("svg")!.getAttribute("width")).toBe("24");
    defaultView.unmount();
  });

  it("is aria-hidden by default, and exposes role=img + aria-label when one is given", () => {
    const hiddenView = renderIntoBody(<Icon icon="home" />);
    expect(hiddenView.container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    hiddenView.unmount();

    const labeledView = renderIntoBody(<Icon icon="lock" aria-label="Locked" />);
    const svg = labeledView.container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("false");
    expect(svg.getAttribute("aria-label")).toBe("Locked");
    expect(svg.getAttribute("role")).toBe("img");
    labeledView.unmount();
  });
});

describe("Icon — lucide fallback (U7: only where the prototype draws no custom glyph)", () => {
  it("a LucideIcon component value renders through lucide-react, honoring the strokeWidth prop", () => {
    // Phosphor glyphs hardcode 1.55 regardless of this prop (previous
    // describe block) — a lucide component must NOT, which is the
    // resolution-order proof: passing a component (not a string) takes
    // the fallback branch, not the custom-name branch.
    const view = renderIntoBody(<Icon icon={X} strokeWidth={2.5} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("2.5");
    view.unmount();
  });

  it("lucide fallback still respects the default 1.75 stroke and 24px default size", () => {
    const view = renderIntoBody(<Icon icon={X} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
    expect(svg.getAttribute("width")).toBe("24");
    view.unmount();
  });
});
