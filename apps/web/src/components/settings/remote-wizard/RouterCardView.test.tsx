// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RouterCardView tests — the shared router-cards.ts renderer +
// brand picker three call sites depend on.

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { RouterBrandPicker, RouterCardPanel } from "./RouterCardView.js";
import { buildPortForwardCard, buildWanAddressCard, ROUTER_BRAND_IDS } from "@loombre/shared/remote";

let view: TestRender | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function textOf(): string {
  return document.body.textContent ?? "";
}

describe("RouterCardPanel — renders a router-cards.ts RouterCard", () => {
  it("renders title, intro, every step, and the diagram description", () => {
    const card = buildPortForwardCard("generic", { protocol: "udp", externalPort: 51820, internalPort: 51820 });
    view = renderIntoBody(<RouterCardPanel card={card} />);
    expect(textOf()).toContain(card.title);
    expect(textOf()).toContain(card.intro);
    for (const step of card.steps) {
      expect(textOf()).toContain(step.heading);
      expect(textOf()).toContain(step.body);
    }
    const diagram = document.body.querySelector('[role="img"]');
    expect(diagram).not.toBeNull();
    expect(diagram?.getAttribute("aria-label")).toBe(card.diagram.description);
  });

  it("renders a WAN-address card (RG11) the same way", () => {
    const card = buildWanAddressCard("netgear");
    view = renderIntoBody(<RouterCardPanel card={card} />);
    expect(textOf()).toContain("Netgear");
    expect(textOf()).toMatch(/100\.64/);
  });
});

describe("RouterBrandPicker — brand selection", () => {
  it("lists every ROUTER_BRAND_IDS option and reports the choice", async () => {
    const onChange = vi.fn();
    view = renderIntoBody(<RouterBrandPicker value="generic" onChange={onChange} />);
    const radios = Array.from(document.body.querySelectorAll('[role="radio"]'));
    expect(radios.length).toBe(ROUTER_BRAND_IDS.length);

    const netgear = radios.find((r) => (r.textContent ?? "").includes("Netgear")) as HTMLButtonElement;
    await act(async () => {
      netgear.click();
    });
    expect(onChange).toHaveBeenCalledWith("netgear");
  });
});
