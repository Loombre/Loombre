// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteWizard tests — wizard-state -> UI wiring (each stage
// renders per the frozen packages/shared StageId state machine), interview
// -> recommendation correctness against recommendPath fixtures, path-flow
// navigation (including R5's real acme/reverse-proxy branch), deep-link
// seeding, and a both-breakpoints smoke test (SheetOrModal.test.tsx's
// matchMedia stub convention — see the note at the bottom of this file for
// why it's a smoke test here, not a structural-swap test).

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { RemoteWizard } from "./RemoteWizard.js";
import { PATH_FLOW_STEPS } from "@loombre/shared/remote";

let view: TestRender | undefined;
const onCancel = vi.fn();
const onFinished = vi.fn();

afterEach(() => {
  view?.unmount();
  view = undefined;
  onCancel.mockReset();
  onFinished.mockReset();
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

function currentStagePill(): string | undefined {
  const el = document.body.querySelector('[data-state="current"]');
  return el?.textContent ?? undefined;
}

async function render(props: Partial<React.ComponentProps<typeof RemoteWizard>> = {}): Promise<void> {
  view = renderIntoBody(<RemoteWizard onCancel={onCancel} onFinished={onFinished} {...props} />);
  await act(async () => {});
}

async function answerInterview(answers: { app: "yes" | "no"; url: "yes" | "no"; router: "yes" | "no" }): Promise<void> {
  const willingButtons = Array.from(document.body.querySelectorAll('[role="radiogroup"]'));
  // Order matches InterviewStage.tsx: [audience, app, url, router]
  function clickWithin(group: Element, label: string): void {
    const btn = Array.from(group.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label);
    if (!btn) throw new Error(`no "${label}" option in group`);
    btn.click();
  }
  await act(async () => {
    clickWithin(willingButtons[1]!, answers.app === "yes" ? "Yes" : "No");
    clickWithin(willingButtons[2]!, answers.url === "yes" ? "Yes" : "No");
    clickWithin(willingButtons[3]!, answers.router === "yes" ? "Yes" : "No");
  });
}

describe("RemoteWizard — stage state machine renders the right stage component", () => {
  it("starts at 'interview' by default", async () => {
    await render();
    expect(textOf()).toContain("A few questions");
    expect(currentStagePill()).toContain("Interview");
  });

  it("Cancel calls onCancel from the interview stage", async () => {
    await render();
    await click("Cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("completing the interview advances to 'recommendation'", async () => {
    await render();
    await answerInterview({ app: "yes", url: "no", router: "no" });
    await click("See recommendation");
    expect(textOf()).toMatch(/We recommend/);
    expect(currentStagePill()).toContain("Recommendation");
  });

  it("choosing a path in recommendation advances to 'path-flow' showing that path's first step", async () => {
    await render();
    await answerInterview({ app: "yes", url: "no", router: "no" }); // -> recommends remote
    await click("See recommendation");
    await click("Continue with Loombre Remote");
    expect(currentStagePill()).toContain("Set up");
    expect(textOf()).toContain("Setting up Loombre Remote");
    expect(textOf()).toContain("Enable Loombre Remote"); // remote-enable, the first step
  });

  it("completing every step of a path's flow advances to 'proof'", async () => {
    await render({ initialPath: "remote" });
    // remote has 2 steps: remote-enable, remote-enroll-first-device
    await click("Continue");
    await click("Continue");
    expect(currentStagePill()).toContain("Prove it works");
    expect(textOf()).toContain("Prove Loombre Remote actually reaches you");
  });

  it("completing proof advances to 'posture-handoff'; Done calls onFinished", async () => {
    await render({ initialPath: "remote", initialStep: "remote-enroll-first-device" });
    await click("Continue"); // finishes remote's last step -> proof
    await click("Continue"); // proof -> posture-handoff
    expect(currentStagePill()).toContain("Done");
    expect(textOf()).toContain("Loombre Remote is set up");
    expect(document.body.querySelector('[data-testid="posture-card-slot"]')).not.toBeNull();
    await click("Done");
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

describe("RemoteWizard — interview -> recommendation correctness (against recommendPath's own heuristic)", () => {
  it("needs no public URL + everyone willing to install an app -> recommends Loombre Remote", async () => {
    await render();
    await answerInterview({ app: "yes", url: "no", router: "no" });
    await click("See recommendation");
    expect(textOf()).toContain("We recommend Loombre Remote");
  });

  it("needs a public URL + comfortable with router settings -> recommends Direct", async () => {
    await render();
    await answerInterview({ app: "no", url: "yes", router: "yes" });
    await click("See recommendation");
    expect(textOf()).toContain("We recommend Direct");
  });

  it("needs a public URL + NOT comfortable with router settings -> recommends Tunnel", async () => {
    await render();
    await answerInterview({ app: "no", url: "yes", router: "no" });
    await click("See recommendation");
    expect(textOf()).toContain("We recommend Tunnel");
  });

  it("not everyone willing to install an app, and no public URL needed -> still falls to Tunnel/Direct by router comfort (recommendPath is total)", async () => {
    await render();
    await answerInterview({ app: "no", url: "no", router: "no" });
    await click("See recommendation");
    expect(textOf()).toContain("We recommend Tunnel");
  });

  it("the admin can override the recommendation and continue with a different path", async () => {
    await render();
    await answerInterview({ app: "yes", url: "no", router: "no" }); // recommends remote
    await click("See recommendation");
    expect(textOf()).toContain("We recommend Loombre Remote");
    // Override: pick Tunnel instead.
    const tunnelOption = Array.from(document.body.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").startsWith("Tunnel"),
    ) as HTMLButtonElement;
    await act(async () => {
      tunnelOption.click();
    });
    await click("Continue with Tunnel");
    expect(textOf()).toContain("Setting up Tunnel");
  });
});

describe("RemoteWizard — Direct's real acme/reverse-proxy branch (R5, exercised through the UI)", () => {
  it("choosing 'Loombre issues it automatically' visits direct-acme-test next", async () => {
    await render({ initialPath: "direct" });
    expect(textOf()).toContain("Choose how Direct is set up");
    await click("Loombre issues it automatically");
    expect(textOf()).toContain("Test certificate issuance");
  });

  it("choosing 'I already have a reverse proxy' SKIPS direct-acme-test straight to direct-enable (nextPathFlowStep's documented skip)", async () => {
    await render({ initialPath: "direct" });
    await click("I already have a reverse proxy");
    // The step LIST still lists every one of the path's possible steps
    // (including the skipped one, as an "upcoming"/never-visited entry) —
    // what must be true is which one is CURRENT, not that the label is
    // absent from the page entirely.
    const stepsList = document.body.querySelector('ol[aria-label$="setup steps"]');
    const current = stepsList?.querySelector('[data-state="current"]');
    expect(current?.textContent).toContain("Enable Direct access");
    const done = stepsList?.querySelectorAll('[data-state="done"]');
    expect(Array.from(done ?? []).some((el) => (el.textContent ?? "").includes("Test certificate issuance"))).toBe(false);
  });

  it("PATH_FLOW_STEPS['direct'] itself still lists direct-acme-test (only the UI transition skips it, not the frozen table)", () => {
    expect(PATH_FLOW_STEPS.direct).toContain("direct-acme-test");
  });
});

describe("RemoteWizard — deep-link seeding (freeze decision 5)", () => {
  it("initialPath alone opens directly at path-flow, first step", async () => {
    await render({ initialPath: "tunnel" });
    expect(currentStagePill()).toContain("Set up");
    expect(textOf()).toContain("Connect your Cloudflare account"); // tunnel-token, first step
  });

  it("initialPath + initialStep seeks to that exact step", async () => {
    await render({ initialPath: "direct", initialStep: "direct-router-instructions" });
    expect(textOf()).toContain("Forward a port on your router");
  });

  it("initialStage overrides the derived default entirely (posture-handoff for an already-active path)", async () => {
    await render({ initialStage: "posture-handoff", initialPath: "remote" });
    expect(currentStagePill()).toContain("Done");
    expect(textOf()).toContain("Loombre Remote is set up");
  });

  it("backing out of a path-flow's first step returns to 'interview' when no interview answers exist (deep-link case)", async () => {
    await render({ initialPath: "remote" });
    await click("Back");
    expect(currentStagePill()).toContain("Interview");
  });
});

// Both-breakpoints (mission requirement): jsdom has no window.matchMedia at
// all (SheetOrModal.test.tsx's own header), so any component that reads it
// needs the stub. RemoteWizard itself never calls useMediaQuery — every
// reflow here is plain CSS (@media in the .module.css files), the
// convention use-media-query.ts's own header reserves JS matchMedia for
// picking between structurally DIFFERENT component subtrees, which this
// wizard never needs (SettingsShell already provides that structural swap
// one level up, per RemoteAccessSection.tsx). This is therefore a smoke
// test — the same content renders without error at both matchMedia
// answers — rather than an assertion of different output, which would be
// dishonest for a component with no JS-side breakpoint branch.
describe("RemoteWizard — both breakpoints (matchMedia stub convention)", () => {
  function installMatchMedia(matches: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the same interview content whether the phone media query matches or not", async () => {
    installMatchMedia(true);
    await render();
    expect(textOf()).toContain("A few questions");
    view?.unmount();
    view = undefined;

    installMatchMedia(false);
    await render();
    expect(textOf()).toContain("A few questions");
  });
});
