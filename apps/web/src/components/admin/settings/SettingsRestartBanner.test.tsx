// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/SettingsRestartBanner.test.tsx
//
// N6 precedence coverage: "system notice > restart-pending" — one
// top-of-page banner class at a time. The restartPendingKeys rendering
// itself had no prior test file (a gap this lane also closes in passing);
// the focus here is the new suppression behavior wired through
// useSystemNoticeOptional().

import { describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

interface MockValue {
  bannerVisible: boolean;
}

let mockValue: MockValue | null = { bannerVisible: false };

vi.mock("../../notices/SystemNoticeProvider.js", () => ({
  useSystemNoticeOptional: () => mockValue,
}));

const { SettingsRestartBanner } = await import("./SettingsRestartBanner.js");

function render(keys: string[]): TestRender {
  return renderIntoBody(<SettingsRestartBanner keys={keys} />);
}

describe("SettingsRestartBanner", () => {
  it("renders the restart-pending banner when keys are non-empty and no system notice is showing", () => {
    mockValue = { bannerVisible: false };
    const view = render(["mail.smtpHost"]);
    expect(view.container.textContent).toContain("Restart required to fully apply");
    expect(view.container.textContent).toContain("mail.smtpHost");
    view.unmount();
  });

  it("renders nothing when keys are empty, regardless of notice state", () => {
    mockValue = { bannerVisible: false };
    const view = render([]);
    expect(view.container.firstChild).toBeNull();
    view.unmount();
  });

  it("N6: suppresses itself while a warning/critical system notice banner is visible, even with pending keys", () => {
    mockValue = { bannerVisible: true };
    const view = render(["mail.smtpHost"]);
    expect(view.container.firstChild).toBeNull();
    view.unmount();
  });

  it("N6: returns the instant the notice clears", () => {
    mockValue = { bannerVisible: true };
    const view = render(["mail.smtpHost"]);
    expect(view.container.firstChild).toBeNull();

    mockValue = { bannerVisible: false };
    view.rerender(<SettingsRestartBanner keys={["mail.smtpHost"]} />);
    expect(view.container.textContent).toContain("Restart required to fully apply");
    view.unmount();
  });

  it("fails OPEN (still shows the restart banner) when rendered outside a SystemNoticeProvider — never silently hides an operator-relevant banner", () => {
    mockValue = null;
    const view = render(["mail.smtpHost"]);
    expect(view.container.textContent).toContain("Restart required to fully apply");
    view.unmount();
  });
});
