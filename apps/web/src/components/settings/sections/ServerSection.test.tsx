// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ServerSection regression test — LD-2 (owner QA, 2026-08-10).
//
// Settings → Server's hardware-transcoding card used to call
// GET /system/capabilities and read `details["hw-transcode"]`. That route
// is PUBLIC/unauthenticated and deliberately zero-I/O
// (apps/server/src/session/system.controller.ts) — it hardcodes
// `hw-transcode.enabled: false` UNCONDITIONALLY, by design, so the card
// was structurally incapable of ever reporting "available" no matter what
// the real probe found. The fix makes ServerSection compose the exact
// same CapabilitiesCard component the admin Dashboard renders
// (components/admin/system/CapabilitiesCard.tsx), reading
// GET /admin/capabilities instead.
//
// This test seeds the SAME fixture shape that makes the Dashboard's own
// CapabilitiesCard report "available" (a completed probe with a real
// accelerated backend) and asserts the Settings → Server surface shows it
// too, never falling back to "Not available" — the exact divergence the
// owner screenshotted — and pins the endpoint actually called.
//
// Harness mirrors ServerPowerCard.test.tsx / DirectoryPicker.test.tsx
// (vi.mock of api-client BEFORE a top-level-await import; renderIntoBody;
// act).

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    super("error");
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { ServerSection } = await import("./ServerSection.js");

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function textOf(): string {
  return document.body.textContent ?? "";
}

/** The exact fixture shape that makes the Dashboard's CapabilitiesCard say
 *  "available": a completed probe with a real, non-software backend. */
const ACCELERATED_ENVELOPE = {
  report: {
    platform: "linux",
    ffmpegBuildHash: "abc123def456abc123def456",
    gpuFingerprint: "NVIDIA GeForce RTX 3060",
    verifiedAtMs: Date.now(),
    backends: [
      {
        position: 0,
        name: "nvenc",
        decode: ["h264", "hevc"],
        encode: ["h264", "hevc"],
        toneMap: [],
      },
    ],
  },
  probe: { status: "completed", lastError: null, updatedAtMs: Date.now() },
};

async function render(): Promise<void> {
  view = renderIntoBody(<ServerSection heading="Server" />);
  await act(async () => {});
}

describe("ServerSection — LD-2 hardware-transcoding divergence", () => {
  it("reads GET /admin/capabilities (the Dashboard's own endpoint), never the public GET /system/capabilities stub", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/capabilities") return Promise.resolve(ACCELERATED_ENVELOPE);
      throw new Error(`unexpected apiGet(${path})`);
    });

    await render();

    expect(apiGetMock).toHaveBeenCalledWith("/admin/capabilities");
    expect(apiGetMock).not.toHaveBeenCalledWith("/system/capabilities");
  });

  it("shows the SAME 'available' truth the Dashboard shows for a real accelerated backend — never falls back to Not available", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/capabilities") return Promise.resolve(ACCELERATED_ENVELOPE);
      throw new Error(`unexpected apiGet(${path})`);
    });

    await render();

    const text = textOf();
    expect(text).not.toContain("Not available");
    expect(text).not.toContain("NOT AVAILABLE");
    // The real probed backend renders on this page — the same fact row the
    // Dashboard's CapabilitiesCard shows.
    expect(text).toContain("nvenc");
  });
});
