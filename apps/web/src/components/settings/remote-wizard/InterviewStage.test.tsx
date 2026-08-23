// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/remote-wizard/InterviewStage.test.tsx
//
// browser-admin-F12 (P3, QA sweep 2026-08-20/21): the second question's
// legend substituted "everyone" -> "you" for the "Just me" audience answer
// but kept the plural verb ("Is you willing...") instead of switching to
// "Are you willing...". "Is everyone who needs access willing..." (the
// other branch) is correct as-is — "everyone" takes a singular verb.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { InterviewStage } from "./InterviewStage.js";

describe("InterviewStage", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function installLegend(): HTMLElement {
    return view!.container.querySelector('[role="radiogroup"][aria-label*="willing to install"]')!;
  }

  async function chooseAudience(label: string): Promise<void> {
    const button = Array.from(view!.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
      (el) => (el.textContent ?? "").includes(label),
    )!;
    await act(async () => {
      button.click();
    });
  }

  it('reads "Are you willing..." (not "Is you willing...") when the audience is "Just me"', async () => {
    view = renderIntoBody(<InterviewStage onComplete={() => {}} />);
    await act(async () => {});
    await chooseAudience("Just me");
    const legend = installLegend().getAttribute("aria-label") ?? "";
    expect(legend).toBe("Are you willing to install a small app (like WireGuard) on each device?");
    expect(legend).not.toMatch(/^Is you\b/);
  });

  it('reads "Is everyone who needs access willing..." when the audience is "A few people I trust"', async () => {
    view = renderIntoBody(<InterviewStage onComplete={() => {}} />);
    await act(async () => {});
    await chooseAudience("A few people I trust");
    const legend = installLegend().getAttribute("aria-label") ?? "";
    expect(legend).toBe("Is everyone who needs access willing to install a small app (like WireGuard) on each device?");
  });
});
