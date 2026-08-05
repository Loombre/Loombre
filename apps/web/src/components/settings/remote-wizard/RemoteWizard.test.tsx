// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteWizard tests — wizard-state -> UI wiring (each stage
// renders per the frozen packages/shared StageId state machine), interview
// -> recommendation correctness against recommendPath fixtures, path-flow
// navigation (including R5's real acme/reverse-proxy branch), deep-link
// seeding, and a both-breakpoints smoke test (SheetOrModal.test.tsx's
// matchMedia stub convention — see the note at the bottom of this file for
// why it's a smoke test here, not a structural-swap test).

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { PATH_FLOW_STEPS } from "@loombre/shared/remote";

// U2 (this lane): every path-flow step is now a real screen making real
// apiGet/apiPost calls (RemoteEnableStepBody/RemoteEnrollStepBody/
// TunnelTokenStepBody/TunnelEnableStepBody/DirectAcmeTestStepBody/
// DirectEnableStepBody/DirectRouterInstructionsStepBody, plus the real
// ProofStage) — U1's own RemoteWizard.test.tsx predates all of that and
// never mocked api-client (nothing under test called it). Mocked here now,
// with safe non-hanging DEFAULTS for every endpoint a step body might hit
// on mere mount (most of the tests below only glance at a step's title,
// never interact with it) — the two tests that actually WALK a path's
// full flow through to 'proof'/'posture-handoff' additionally script
// per-call responses for the exact sequence they drive.
const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `Request failed with status ${status}`;
    super(title);
    this.status = status;
    this.problem = problem;
  }
}

const DEFAULT_WIREGUARD_STATUS = { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 };
const DEFAULT_TUNNEL_STATUS = { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null, tokenConfigured: false, tokenSetAtMs: null, tokenScopesOk: null };
const DEFAULT_USERS_PAGE = {
  items: [{ id: "u1", username: "admin", displayName: "Admin", email: null, isAdmin: true, birthDate: null, maxContentRating: null, createdAtMs: 1, updatedAtMs: 1 }],
  nextCursor: null,
};
const DEFAULT_REMOTE_STATE = {
  activePath: "none",
  wireguard: DEFAULT_WIREGUARD_STATUS,
  tunnel: DEFAULT_TUNNEL_STATUS,
  direct: { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null },
};

function installDefaultApiMocks(): void {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/admin/remote/wireguard/status") return Promise.resolve(DEFAULT_WIREGUARD_STATUS);
    if (path === "/users") return Promise.resolve(DEFAULT_USERS_PAGE);
    if (path === "/admin/remote/tunnel/status") return Promise.resolve(DEFAULT_TUNNEL_STATUS);
    if (path === "/admin/remote/state") return Promise.resolve(DEFAULT_REMOTE_STATE);
    return Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
  });
  apiPostMock.mockImplementation(() => Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 })));
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
  apiErrorMessage: (err: unknown, fallback: string): string => {
    if (err && typeof err === "object") {
      const problem = (err as { problem?: unknown }).problem;
      if (problem && typeof problem === "object" && typeof (problem as { detail?: unknown }).detail === "string" && (problem as { detail?: string }).detail) {
        return (problem as { detail: string }).detail;
      }
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return fallback;
  },
}));

const { RemoteWizard } = await import("./RemoteWizard.js");

let view: TestRender | undefined;
const onCancel = vi.fn();
const onFinished = vi.fn();

beforeEach(() => {
  installDefaultApiMocks();
});

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

  function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const ENABLED_WIREGUARD_STATUS = { enabled: true, listening: true, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: "vpn.example.com", peerCount: 0 };
  const ENROLLMENT_RESPONSE = {
    device: { id: "d1", userId: "u1", name: "Alex's iPhone", tunnelIp: "10.82.146.2", createdAtMs: 1, lastHandshakeAtMs: null },
    configText: "[Interface]\nPrivateKey = a\n",
  };

  async function completeRemoteEnableStep(): Promise<void> {
    apiPostMock.mockImplementation((path: string) => {
      if (path === "/admin/remote/wireguard/enable") return Promise.resolve(ENABLED_WIREGUARD_STATUS);
      if (path === "/admin/remote/wireguard/devices") return Promise.resolve(ENROLLMENT_RESPONSE);
      return Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    });
    await click("Enable Loombre Remote");
    await click("Continue");
  }

  async function completeRemoteEnrollStep(): Promise<void> {
    await act(async () => {
      const nameInput = document.body.querySelector('input[placeholder*="iPhone"]') as HTMLInputElement;
      setNativeValue(nameInput, "Alex's iPhone");
    });
    await click("Enroll device");
    await act(async () => {
      (document.body.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await click("Continue");
  }

  it("completing every step of a path's flow advances to 'proof'", async () => {
    await render({ initialPath: "remote" });
    // remote has 2 real steps: remote-enable (enable, then Continue),
    // remote-enroll-first-device (fill + enroll + confirm + Continue).
    await completeRemoteEnableStep();
    await completeRemoteEnrollStep();
    expect(currentStagePill()).toContain("Prove it works");
    expect(textOf()).toContain("Prove Loombre Remote actually reaches you");
  });

  it("completing proof advances to 'posture-handoff'; Done calls onFinished", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/remote/wireguard/status") return Promise.resolve(DEFAULT_WIREGUARD_STATUS);
      if (path === "/users") return Promise.resolve(DEFAULT_USERS_PAGE);
      if (path === "/admin/remote/state") return Promise.resolve({ ...DEFAULT_REMOTE_STATE, wireguard: ENABLED_WIREGUARD_STATUS });
      // ProofStage's poll target — arrives on the very first poll (no
      // fake timers needed: the poll effect fires once synchronously on
      // mount, ahead of the interval).
      if (path === "/admin/remote/probes/{id}") return Promise.resolve({ id: "p1", status: "arrived", arrivedAtMs: 1, diagnosis: null });
      return Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    });
    apiPostMock.mockImplementation((path: string) => {
      if (path === "/admin/remote/wireguard/devices") return Promise.resolve(ENROLLMENT_RESPONSE);
      if (path === "/admin/remote/probes")
        return Promise.resolve({ id: "p1", probeUrl: "https://vpn.example.com/probe/tok", qrPayload: "https://vpn.example.com/probe/tok", expiresAtMs: Date.now() + 900_000 });
      return Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    });

    await render({ initialPath: "remote", initialStep: "remote-enroll-first-device" });
    await completeRemoteEnrollStep(); // finishes remote's last step -> proof
    await act(async () => {}); // let ProofStage's mount effects (state read -> mint -> first poll) settle
    await click("Continue →"); // proof (arrived) -> posture-handoff

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
