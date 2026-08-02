// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/MailTestSendCard.test.tsx
//
// M11/E6: POST /admin/mail/test-send -> {jobId} -> job.updated (filtered by
// jobId) reported all three ways (delivered / failed with the real SMTP
// error / pending), plus the 409-unconfigured explanation naming exactly
// which prerequisites are unset. apiPost and getEventsSocket are mocked
// (StreamsPanel.test.tsx's established events-socket-mocking convention).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiPostMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { MailTestSendCard } = await import("./MailTestSendCard.js");

type AdminSettingsResponse = components["schemas"]["AdminSettingsResponse"];

function settingsWith(overrides: Record<string, unknown>): AdminSettingsResponse {
  const base: Record<string, unknown> = {
    "mail.smtpHost": "smtp.example.com",
    "mail.fromAddress": "noreply@example.com",
    "network.publicUrl": "https://loombre.example.com",
    ...overrides,
  };
  return {
    settings: Object.entries(base).map(([key, value]) => ({
      key,
      value,
      source: "database",
      requiresRestart: false,
      locked: false,
    })),
    restartPendingKeys: [],
    providerKeys: [],
  } as unknown as AdminSettingsResponse;
}

const FULLY_CONFIGURED = settingsWith({});

describe("MailTestSendCard — M11/E6", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiPostMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function buttonFor(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    if (!button) throw new Error(`no button labelled "${text}"`);
    return button as HTMLButtonElement;
  }

  function inputFor(): HTMLInputElement {
    return view!.container.querySelector("input")!;
  }

  async function submit(to: string): Promise<void> {
    function setNativeValue(el: HTMLInputElement, value: string): void {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setNativeValue(inputFor(), to);
    await act(async () => {
      buttonFor("Send test").click();
    });
  }

  it("enqueues the test send and shows a pending state while queued/active", async () => {
    apiPostMock.mockResolvedValue({ jobId: "job-1" });
    view = renderIntoBody(<MailTestSendCard settings={FULLY_CONFIGURED} />);

    await submit("me@example.com");

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/admin/mail/test-send");
    expect(options.body["to"]).toBe("me@example.com");
    expect(view.container.textContent).toMatch(/waiting for the send to complete/i);
  });

  it("subscribes to job.updated and reports DELIVERED on a completed status for the matching jobId", async () => {
    apiPostMock.mockResolvedValue({ jobId: "job-2" });
    view = renderIntoBody(<MailTestSendCard settings={FULLY_CONFIGURED} />);
    await submit("me@example.com");

    const handler = subscribeMock.mock.calls.find(([type]) => type === "job.updated")?.[1] as
      | ((event: unknown) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");

    // A DIFFERENT job's event must be ignored. (The static help text above
    // already contains the word "delivered" in prose — assert the terminal
    // outcome line's exact rendered copy, "Delivered.", not a loose
    // case-insensitive substring match against the whole card.)
    act(() => handler!({ payload: { jobId: "some-other-job", status: "completed" } }));
    expect(view!.container.textContent).not.toContain("Delivered.");
    expect(view!.container.textContent).toMatch(/waiting for the send to complete/i);

    act(() => handler!({ payload: { jobId: "job-2", status: "completed" } }));
    expect(view!.container.textContent).toContain("Delivered.");
  });

  it("reports FAILED with the REAL SMTP error text from the event payload", async () => {
    apiPostMock.mockResolvedValue({ jobId: "job-3" });
    view = renderIntoBody(<MailTestSendCard settings={FULLY_CONFIGURED} />);
    await submit("me@example.com");

    const handler = subscribeMock.mock.calls.find(([type]) => type === "job.updated")?.[1] as (event: unknown) => void;
    act(() =>
      handler({ payload: { jobId: "job-3", status: "failed", errorMessage: "535 5.7.8 Authentication failed" } }),
    );

    expect(view!.container.textContent).toContain("535 5.7.8 Authentication failed");
  });

  it("409: explains mail isn't configured, listing exactly the unset prerequisites", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError("Mail not configured", 409));
    view = renderIntoBody(
      <MailTestSendCard settings={settingsWith({ "mail.smtpHost": "", "network.publicUrl": "" })} />,
    );
    await submit("me@example.com");

    expect(view.container.textContent).toMatch(/isn't configured yet/i);
    expect(view.container.textContent).toContain("SMTP host (mail.smtpHost)");
    expect(view.container.textContent).toContain("public URL (network.publicUrl)");
    // fromAddress WAS set in this fixture — must not be listed as missing.
    expect(view.container.textContent).not.toContain("from address (mail.fromAddress)");
  });

  it("a non-409 rejection shows a plain error, not the unconfigured explanation", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError("Rate limited.", 429));
    view = renderIntoBody(<MailTestSendCard settings={FULLY_CONFIGURED} />);
    await submit("me@example.com");

    expect(view.container.textContent).toContain("Rate limited.");
    expect(view.container.textContent).not.toMatch(/isn't configured yet/i);
  });
});
