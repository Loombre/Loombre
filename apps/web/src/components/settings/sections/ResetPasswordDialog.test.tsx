// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/ResetPasswordDialog.test.tsx
//
// E3a/M14: the confirm -> POST -> one-time reveal flow, plus the honest
// self-reset warning (isSelf).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiPostMock = vi.fn();

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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { ResetPasswordDialog } = await import("./ResetPasswordDialog.js");

const USER = {
  id: "user-1",
  username: "june",
  email: "june@example.com",
  displayName: null,
  isAdmin: false,
  birthDate: null,
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

describe("ResetPasswordDialog — E3a/M14", () => {
  let view: TestRender | null = null;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    apiPostMock.mockReset();
    Object.assign(navigator, { clipboard: { writeText } });
    writeText.mockClear();
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

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  it("names the user and states the real consequences before doing anything", () => {
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={() => {}} />);
    expect(view.container.textContent).toContain("june");
    expect(view.container.textContent).toMatch(/signs .* out of every device/i);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("the self-reset case names it explicitly — the admin's OWN session dies too", () => {
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf onClose={() => {}} />);
    expect(view.container.textContent).toMatch(/your own account/i);
    expect(view.container.textContent).toMatch(/signs out your current session/i);
  });

  it("a non-self target gets no self-reset warning", () => {
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={() => {}} />);
    expect(view.container.textContent).not.toMatch(/your own account/i);
  });

  it("confirming POSTs /users/{id}/reset-password and reveals the one-time temporaryPassword", async () => {
    apiPostMock.mockResolvedValue({ temporaryPassword: "correct-horse-battery-staple" });
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={() => {}} />);

    await click(buttonFor("Reset password"));

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPostMock.mock.calls[0] as [string, { params: { path: { id: string } } }];
    expect(path).toBe("/users/{id}/reset-password");
    expect(options.params.path.id).toBe("user-1");

    expect(view.container.textContent).toContain("correct-horse-battery-staple");
    expect(view.container.textContent).toMatch(/will not be shown again/i);
    // The confirm copy is gone — this is the reveal step now.
    expect(view.container.textContent).not.toMatch(/signs .* out of every device/i);
  });

  it("copies the revealed temporary password", async () => {
    apiPostMock.mockResolvedValue({ temporaryPassword: "one-time-secret-999" });
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={() => {}} />);
    await click(buttonFor("Reset password"));

    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await click(copyButton);
    expect(writeText).toHaveBeenCalledWith("one-time-secret-999");
  });

  it("Cancel closes without calling the endpoint", async () => {
    const onClose = vi.fn();
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={onClose} />);
    await click(buttonFor("Cancel"));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a rejected reset shows the error and stays on the confirm step", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError("User not found."));
    view = renderIntoBody(<ResetPasswordDialog user={USER} isSelf={false} onClose={() => {}} />);

    await click(buttonFor("Reset password"));

    expect(view.container.textContent).toContain("User not found.");
    // Still on the confirm step — the Reset password button is present again.
    expect(() => buttonFor("Reset password")).not.toThrow();
  });
});
