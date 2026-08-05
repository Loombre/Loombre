// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: DirectRouterInstructionsStepBody tests — TCP 80 + 443 router
// cards, brand switching, navigation.

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { DirectRouterInstructionsStepBody } from "./DirectRouterInstructionsStepBody.js";

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

afterEach(() => {
  view?.unmount();
  view = undefined;
  onStepComplete.mockReset();
  onBack.mockReset();
});

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  return match;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

async function render(): Promise<void> {
  view = renderIntoBody(
    <DirectRouterInstructionsStepBody
      path="direct"
      step="direct-router-instructions"
      context={{}}
      onStepComplete={onStepComplete}
      onBack={onBack}
    />,
  );
  await act(async () => {});
}

describe("DirectRouterInstructionsStepBody", () => {
  it("renders both TCP 80 and TCP 443 port-forward cards", async () => {
    await render();
    expect(textOf()).toContain("TCP port 80");
    expect(textOf()).toContain("TCP port 443");
  });

  it("switching brand re-renders both cards with that brand's content", async () => {
    await render();
    const asus = Array.from(document.body.querySelectorAll('[role="radio"]')).find((r) => (r.textContent ?? "").includes("ASUS")) as HTMLButtonElement;
    await act(async () => {
      asus.click();
    });
    expect(textOf()).toContain("router.asus.com");
  });

  it("Continue calls onStepComplete; Back calls onBack", async () => {
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
