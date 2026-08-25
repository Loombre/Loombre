// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/system/LogsTailCard.test.tsx
//
// LD-11 (this implementation run's lane B3): every install shape
// now sets LOOMBRE_LOG_FILE automatically (macOS pkg, Windows MSI, Docker,
// Linux tarball — see installers/**), so the `source === null` empty state
// this card renders is now primarily a DEV/SOURCE-RUN signal rather than
// "every install lands here." This pins the rewritten copy (see
// LogsTailCard.tsx's header for the full W12 -> W3-R -> LD-11 history) and
// proves the unset case still degrades gracefully — apiGet mocked per the
// established convention (StreamsPanel.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();

// d4-e6: the fake mirrors the real LoombreApiError's SHAPE, not just its
// identity. Every error the SDK throws carries an HTTP `status`, and the
// surfaces now read their copy through `apiErrorCopy` (lib/api-error-
// message.ts), which duck-types that status instead of the class — so a
// fake without one is not a stand-in for anything the app can receive, and
// a test built on it would prove nothing about the real path. 422 is the
// ordinary validation rejection; tests that need another Object.assign it.
class FakeApiError extends Error {
  status = 422;
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

const { LogsTailCard } = await import("./LogsTailCard.js");

describe("LogsTailCard — LD-11 empty-state copy", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("source: null (LOOMBRE_LOG_FILE unset — e.g. a source/dev run) renders the graceful empty state, not an error", async () => {
    apiGetMock.mockResolvedValue({ source: null, lines: [] });
    view = renderIntoBody(<LogsTailCard />);
    await act(async () => {});

    const text = view.container.textContent ?? "";
    expect(text).toContain("No log file to show here");
    // Both halves of the LD-11 story: installed builds handle it
    // automatically, AND a source run landing here is expected/fine —
    // neither half should read as an error state.
    expect(text).toMatch(/installed builds/i);
    expect(text).toMatch(/running from source/i);
    // The env var name stays present but demoted to a secondary technical
    // line, and the docs link survives (both pre-existing, W3-R-mandated
    // facts this rewrite must not silently drop).
    expect(text).toContain("LOOMBRE_LOG_FILE is not set on this instance");
    const envRefLink = view.container.querySelector('a[href="https://loombre.com/docs/ops/env-reference"]');
    expect(envRefLink).not.toBeNull();
    expect(envRefLink?.textContent).toBe("Environment reference");
  });

  it("source: null copy never claims every install lands here (the exact W3-R-caught falsehood, now flipped by LD-11)", async () => {
    apiGetMock.mockResolvedValue({ source: null, lines: [] });
    view = renderIntoBody(<LogsTailCard />);
    await act(async () => {});

    const text = view.container.textContent ?? "";
    // The OLD (pre-LD-11) copy's core claim — that this server writes only
    // to console output full stop — is no longer universally true and must
    // not be restated as if it still were.
    expect(text).not.toMatch(/writes its logs to its console output rather than to a log file/i);
  });

  it("source: a real filename (LOOMBRE_LOG_FILE configured, e.g. by an installed build) renders the log content, not the empty state", async () => {
    apiGetMock.mockResolvedValue({ source: "server.log", lines: ["line one", "line two"] });
    view = renderIntoBody(<LogsTailCard />);
    await act(async () => {});

    const text = view.container.textContent ?? "";
    expect(text).toContain("Source: server.log");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(text).not.toContain("No log file to show here");
  });

  it("source: a configured but not-yet-populated file (real install, first boot) shows the empty tail marker, not the null-source empty state", async () => {
    // tailLogFile's documented shape (apps/server/src/catalog/
    // admin-logs-tail.ts): a CONFIGURED path that can't be read yet is
    // {source: <basename>, lines: []} — distinct from {source: null, ...}.
    apiGetMock.mockResolvedValue({ source: "server.log", lines: [] });
    view = renderIntoBody(<LogsTailCard />);
    await act(async () => {});

    const text = view.container.textContent ?? "";
    expect(text).toContain("Source: server.log");
    expect(text).toContain("(empty)");
    expect(text).not.toContain("No log file to show here");
  });

  it("loading state (source undefined, before the first response) shows a skeleton, not either copy branch", () => {
    apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves
    view = renderIntoBody(<LogsTailCard />);

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("No log file to show here");
    expect(text).not.toMatch(/Source:/);
  });
});
