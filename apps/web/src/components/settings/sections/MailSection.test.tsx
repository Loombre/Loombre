// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/MailSection.test.tsx
//
// Composition-level coverage: the registry fields are filtered to exactly
// mail.* + network.publicUrl (and no other category leaks in), the E1
// posture intro line renders, and the credentials/test-send cards mount
// with real data from GET /admin/settings. Per-card behavior (locked env
// state, replace/clear, the three test-send outcomes) is covered in
// MailCredentialsCard.test.tsx / MailTestSendCard.test.tsx — this file
// only proves MailSection wires them correctly, it doesn't re-drive their
// own state machines.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: class extends Error {},
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { MailSection } = await import("./MailSection.js");

function schemaEntry(key: string, category: string, locked = false): Record<string, unknown> {
  return {
    key,
    category,
    description: `Description for ${key}`,
    scope: locked ? "env" : "ui",
    requiresRestart: false,
    default: "",
    valueSchema: { type: "string" },
    locked,
  };
}

const SCHEMA = {
  entries: [
    schemaEntry("mail.smtpHost", "mail"),
    schemaEntry("mail.smtpPort", "mail"),
    schemaEntry("mail.smtpSecurity", "mail"),
    schemaEntry("mail.fromAddress", "mail"),
    schemaEntry("mail.fromName", "mail"),
    schemaEntry("network.publicUrl", "network"),
    // A decoy from a totally unrelated category — must NOT appear.
    schemaEntry("transcode.hwAccel", "transcode"),
  ],
};

const SETTINGS = {
  settings: [
    { key: "mail.smtpHost", value: "smtp.example.com", source: "database", requiresRestart: false, locked: false },
    { key: "mail.smtpPort", value: 587, source: "database", requiresRestart: false, locked: false },
    { key: "mail.smtpSecurity", value: "starttls", source: "database", requiresRestart: false, locked: false },
    { key: "mail.fromAddress", value: "noreply@example.com", source: "database", requiresRestart: false, locked: false },
    { key: "mail.fromName", value: "Loombre", source: "database", requiresRestart: false, locked: false },
    { key: "network.publicUrl", value: "https://loombre.example.com", source: "database", requiresRestart: false, locked: false },
    { key: "transcode.hwAccel", value: "auto", source: "database", requiresRestart: false, locked: false },
  ],
  restartPendingKeys: [],
  providerKeys: [],
  mailCredentials: { configured: false, setAtMs: null, source: null },
};

describe("MailSection", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/settings/schema") return Promise.resolve(SCHEMA);
      if (path === "/admin/settings") return Promise.resolve(SETTINGS);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<MailSection heading="Mail" />);
    await act(async () => {});
  }

  it("renders the E1 posture intro line", async () => {
    await render();
    expect(view!.container.textContent).toMatch(/mail is optional/i);
    expect(view!.container.textContent).toMatch(/whether or not anything below is configured/i);
  });

  it("filters the registry card to exactly the 5 mail.* keys + network.publicUrl — nothing else leaks in", async () => {
    await render();
    expect(view!.container.textContent).toContain("6 keys");
    expect(view!.container.textContent).not.toContain("transcode.hwAccel");
  });

  it("mounts the credentials card (not-configured state) and the test-send card", async () => {
    await render();
    expect(view!.container.textContent).toContain("SMTP credentials");
    expect(view!.container.textContent).toContain("NOT CONFIGURED");
    expect(view!.container.textContent).toContain("Send a test email");
  });

  it("passes a real (non-fabricated) mailCredentials status through when the server reports one configured via env", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/settings/schema") return Promise.resolve(SCHEMA);
      if (path === "/admin/settings")
        return Promise.resolve({ ...SETTINGS, mailCredentials: { configured: true, setAtMs: null, source: "env" } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await render();
    expect(view!.container.textContent).toContain("LOOMBRE_SMTP_USERNAME");
  });
});
