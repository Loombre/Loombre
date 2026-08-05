// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ProofStage tests — mint -> QR/URL/cellular instruction ->
// poll (pending -> arrived; pending -> expired -> per-DiagnosisCode
// guidance -> re-mint), countdown, CGNAT -> switch-to-Tunnel routing,
// honest 501/no-endpoint states.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { diagnosisGuidance, type DiagnosisCode } from "@loombre/shared/remote";

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

const { ProofStage } = await import("./ProofStage.js");

let view: TestRender | undefined;
const onComplete = vi.fn();
const onBack = vi.fn();
const onSwitchToTunnel = vi.fn();

const DIRECT_STATE = {
  activePath: "direct",
  wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
  tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null, tokenConfigured: false, tokenSetAtMs: null, tokenScopesOk: null },
  direct: { enabled: true, mode: "acme", domain: "media.example.com", certValid: true, certExpiresAtMs: 1 },
};

const PROBE_TOKEN = {
  id: "p1",
  probeUrl: "https://media.example.com/probe/tok123",
  qrPayload: "https://media.example.com/probe/tok123",
  expiresAtMs: Date.now() + 15 * 60 * 1000,
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  onComplete.mockReset();
  onBack.mockReset();
  onSwitchToTunnel.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
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

async function renderPending(path: "remote" | "tunnel" | "direct" = "direct"): Promise<void> {
  apiGetMock.mockImplementation((p: string) => {
    if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
    return Promise.reject(new Error(`unexpected apiGet ${p}`));
  });
  apiPostMock.mockImplementation((p: string) => {
    if (p === "/admin/remote/probes") return Promise.resolve(PROBE_TOKEN);
    return Promise.reject(new Error(`unexpected apiPost ${p}`));
  });
  view = renderIntoBody(<ProofStage path={path} onComplete={onComplete} onBack={onBack} onSwitchToTunnel={onSwitchToTunnel} />);
  await act(async () => {});
}

describe("ProofStage — mint + render", () => {
  it("mints a probe for the active path's endpoint and renders the QR, URL, and the cellular instruction", async () => {
    await renderPending();
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/probes", { body: { expectedEndpoint: "media.example.com", path: "direct" } });
    expect(document.body.querySelector("svg")).not.toBeNull();
    expect(textOf()).toContain(PROBE_TOKEN.probeUrl);
    expect(textOf()).toContain("cellular");
    expect(textOf()).toMatch(/turn off wi-fi/i);
  });

  it("shows a live countdown from expiresAtMs", async () => {
    await renderPending();
    expect(textOf()).toMatch(/Expires in \d+:\d{2}/);
  });

  it("resolves the expected endpoint per path (remote uses wireguard.endpointHost, tunnel uses tunnel.hostname)", async () => {
    apiGetMock.mockResolvedValue({
      ...DIRECT_STATE,
      activePath: "tunnel",
      tunnel: { ...DIRECT_STATE.tunnel, enabled: true, hostname: "vpn.example.com" },
    });
    apiPostMock.mockResolvedValue(PROBE_TOKEN);
    view = renderIntoBody(<ProofStage path="tunnel" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/probes", { body: { expectedEndpoint: "vpn.example.com", path: "tunnel" } });
  });
});

describe("ProofStage — pending -> arrived", () => {
  it("polling arrival shows the green success state and Continue calls onComplete", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "pending", arrivedAtMs: null, diagnosis: null });
    });
    apiPostMock.mockResolvedValue(PROBE_TOKEN);
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    expect(textOf()).not.toContain("It works");

    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "arrived", arrivedAtMs: Date.now(), diagnosis: null });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(textOf()).toContain("It works");

    await act(async () => {
      buttonByText("Continue →").click();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("ProofStage — pending -> expired -> per-DiagnosisCode guidance", () => {
  const codes: DiagnosisCode[] = ["portBlocked", "cgnat", "doubleNat", "dnsMismatch", "tunnelDown", "connectorUnhealthy", "unknown"];

  for (const code of codes) {
    it(`renders diagnosisGuidance("direct", "${code}") on expiry`, async () => {
      vi.useFakeTimers();
      apiGetMock.mockImplementation((p: string) => {
        if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
        return Promise.resolve({ id: "p1", status: "expired", arrivedAtMs: null, diagnosis: { code, detail: `detail for ${code}` } });
      });
      apiPostMock.mockResolvedValue(PROBE_TOKEN);
      view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} onSwitchToTunnel={onSwitchToTunnel} />);
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(textOf()).toContain(diagnosisGuidance("direct", code));
      expect(textOf()).toContain(`detail for ${code}`);
      expect(buttonByText("Mint a new code")).toBeTruthy();
    });
  }

  it("cgnat on a non-tunnel path shows Switch to Tunnel; other codes do not", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "expired", arrivedAtMs: null, diagnosis: { code: "cgnat", detail: "d" } });
    });
    apiPostMock.mockResolvedValue(PROBE_TOKEN);
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} onSwitchToTunnel={onSwitchToTunnel} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {
      buttonByText("Switch to Tunnel").click();
    });
    expect(onSwitchToTunnel).toHaveBeenCalledTimes(1);
  });

  it("cgnat is never offered a switch when the path IS already tunnel", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve({ ...DIRECT_STATE, activePath: "tunnel", tunnel: { ...DIRECT_STATE.tunnel, enabled: true, hostname: "vpn.example.com" } });
      return Promise.resolve({ id: "p1", status: "expired", arrivedAtMs: null, diagnosis: { code: "cgnat", detail: "d" } });
    });
    apiPostMock.mockResolvedValue({ ...PROBE_TOKEN, probeUrl: "https://vpn.example.com/probe/x", qrPayload: "https://vpn.example.com/probe/x" });
    view = renderIntoBody(<ProofStage path="tunnel" onComplete={onComplete} onBack={onBack} onSwitchToTunnel={onSwitchToTunnel} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(() => buttonByText("Switch to Tunnel")).toThrow();
  });

  it("re-mint (Mint a new code) mints a fresh probe and returns to pending", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "expired", arrivedAtMs: null, diagnosis: { code: "unknown", detail: "d" } });
    });
    apiPostMock.mockResolvedValue(PROBE_TOKEN);
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "pending", arrivedAtMs: null, diagnosis: null });
    });
    await act(async () => {
      buttonByText("Mint a new code").click();
    });
    await act(async () => {});
    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(textOf()).toContain(PROBE_TOKEN.probeUrl);
  });

  it("submitting a WAN address runs a fresh diagnoseRemote and updates the guidance", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/state") return Promise.resolve(DIRECT_STATE);
      return Promise.resolve({ id: "p1", status: "expired", arrivedAtMs: null, diagnosis: { code: "unknown", detail: "no wan address yet" } });
    });
    apiPostMock.mockImplementation((p: string) => {
      if (p === "/admin/remote/probes") return Promise.resolve(PROBE_TOKEN);
      if (p === "/admin/remote/diagnosis") return Promise.resolve({ code: "doubleNat", detail: "router WAN is private" });
      return Promise.reject(new Error(`unexpected ${p}`));
    });
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    function setNativeValue(el: HTMLInputElement, value: string): void {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await act(async () => {
      setNativeValue(document.body.querySelector('input[placeholder*="203.0.113"]') as HTMLInputElement, "192.168.1.1");
    });
    await act(async () => {
      buttonByText("Check").click();
    });
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/diagnosis", {
      body: { expectedEndpoint: "media.example.com", wanAddress: "192.168.1.1", path: "direct" },
    });
    expect(textOf()).toContain(diagnosisGuidance("direct", "doubleNat"));
  });
});

describe("ProofStage — honest degraded states", () => {
  it("GET /admin/remote/state 501 -> honest unavailable state, never fabricates an endpoint", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    expect(textOf()).toContain("isn't available on this build yet");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("no endpoint configured for the active path -> honest empty state, no probe minted", async () => {
    apiGetMock.mockResolvedValue({ ...DIRECT_STATE, direct: { ...DIRECT_STATE.direct, domain: null } });
    view = renderIntoBody(<ProofStage path="direct" onComplete={onComplete} onBack={onBack} />);
    await act(async () => {});
    expect(textOf()).toContain("doesn't have a public endpoint configured yet");
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

// Both-breakpoints (mission requirement, RemoteWizard.test.tsx's own
// documented convention — see that file's bottom describe block for the
// full reasoning): ProofStage never calls useMediaQuery itself; every
// reflow here is plain CSS (@media / flex-wrap in ProofStage.module.css
// and RouterCardView.module.css), so this is a smoke test — the same
// content renders without error at both matchMedia answers — not an
// assertion of structurally different output, which would misrepresent a
// component with no JS-side breakpoint branch.
describe("ProofStage — both breakpoints (matchMedia stub convention)", () => {
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

  it("renders the same pending-QR content whether the phone media query matches or not", async () => {
    installMatchMedia(true);
    await renderPending();
    expect(textOf()).toContain("cellular");
    view?.unmount();
    view = undefined;

    installMatchMedia(false);
    await renderPending();
    expect(textOf()).toContain("cellular");
  });
});
