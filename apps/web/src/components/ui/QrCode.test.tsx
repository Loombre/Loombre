// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: QrCode tests — value -> SVG presence (mission: "not
// pixel-perfect"). Asserts structure and that content actually varies with
// input, never rasterized pixels (jsdom has no canvas/paint pipeline).

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderIntoBody, type TestRender } from "./test-render.js";
import { QrCode } from "./QrCode.js";

let view: TestRender | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function svgEl(): SVGSVGElement | null {
  return document.body.querySelector("svg");
}

describe("QrCode — renders an SVG for a given value", () => {
  it("renders an <svg> with a non-empty dark-module <path>", () => {
    view = renderIntoBody(<QrCode value="https://example.com/probe/abc123" label="Test QR" />);
    const svg = svgEl();
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Test QR");
    const path = svg?.querySelector("path");
    expect(path).not.toBeNull();
    expect((path?.getAttribute("d") ?? "").length).toBeGreaterThan(0);
  });

  it("renders a light background <rect> sized to the module grid + quiet zone", () => {
    view = renderIntoBody(<QrCode value="short" label="Test QR" />);
    const rect = svgEl()?.querySelector("rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("fill")).toBe("#ffffff");
    const viewBox = svgEl()?.getAttribute("viewBox") ?? "";
    const [, , w, h] = viewBox.split(" ").map(Number);
    expect(w).toBeGreaterThan(0);
    expect(w).toBe(h); // always square
  });

  it("different values produce different module paths (the QR actually reflects its content)", () => {
    view = renderIntoBody(<QrCode value="value-one" label="A" />);
    const pathA = svgEl()?.querySelector("path")?.getAttribute("d");
    view.unmount();

    view = renderIntoBody(<QrCode value="value-two-a-longer-payload-string" label="B" />);
    const pathB = svgEl()?.querySelector("path")?.getAttribute("d");

    expect(pathA).not.toBe(pathB);
  });

  it("a longer payload produces a larger (or equal) module grid than a short one", () => {
    view = renderIntoBody(<QrCode value="x" label="short" />);
    const shortViewBox = svgEl()?.getAttribute("viewBox") ?? "";
    view.unmount();

    view = renderIntoBody(<QrCode value={"y".repeat(500)} label="long" />);
    const longViewBox = svgEl()?.getAttribute("viewBox") ?? "";

    const shortSize = Number(shortViewBox.split(" ")[2]);
    const longSize = Number(longViewBox.split(" ")[2]);
    expect(longSize).toBeGreaterThanOrEqual(shortSize);
  });

  it("respects the size prop as pixel width/height", () => {
    view = renderIntoBody(<QrCode value="sized" label="Sized" size={96} />);
    const svg = svgEl();
    expect(svg?.getAttribute("width")).toBe("96");
    expect(svg?.getAttribute("height")).toBe("96");
  });
});

describe("QrCode — empty value (honest empty-state, never throws)", () => {
  it("renders a labeled placeholder instead of an <svg>", () => {
    view = renderIntoBody(<QrCode value="" label="Nothing yet" />);
    expect(svgEl()).toBeNull();
    const placeholder = document.body.querySelector('[role="img"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain("No data to encode yet");
  });
});
