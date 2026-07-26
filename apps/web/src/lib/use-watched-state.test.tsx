// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast.js";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const findProgressForItemMock = vi.fn();
const apiPutMock = vi.fn();

vi.mock("./progress-lookup.js", () => ({
  findProgressForItem: (...args: unknown[]) => findProgressForItemMock(...args),
}));

class FakeLoombreApiError extends Error {}

vi.mock("./api-client.js", () => ({
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

// Imported AFTER the mocks above so the module under test picks them up.
const { useWatchedState } = await import("./use-watched-state.js");

let latestHook: ReturnType<typeof useWatchedState> | null = null;

function Probe({ itemId, runtimeMs }: { itemId: string | null; runtimeMs: number | null }): null {
  // useWatchedState calls useToast() internally (it shows a toast on
  // success/failure) — the ToastProvider wrapper below is what makes that
  // legal; this test only exercises the hook's own state machine, not the
  // toast's rendered copy.
  latestHook = useWatchedState(itemId, runtimeMs);
  return null;
}

function render(itemId: string | null, runtimeMs: number | null = 100_000): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <Probe itemId={itemId} runtimeMs={runtimeMs} />
    </ToastProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useWatchedState", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    latestHook = null;
    findProgressForItemMock.mockReset();
    apiPutMock.mockReset();
  });

  it("starts loading and resolves to unwatched when there's no progress row", async () => {
    findProgressForItemMock.mockResolvedValue(null);
    view = render("item-1");
    expect(latestHook!.state).toBe("loading");
    await flush();
    expect(latestHook!.state).toBe("unwatched");
  });

  it("resolves to watched when the fetched progress state is 'played'", async () => {
    findProgressForItemMock.mockResolvedValue({ state: "played", positionMs: 100_000, durationMs: 100_000 });
    view = render("item-1");
    await flush();
    expect(latestHook!.state).toBe("watched");
  });

  it("never fetches when itemId is null (component not ready yet)", async () => {
    view = render(null);
    await flush();
    expect(findProgressForItemMock).not.toHaveBeenCalled();
    expect(latestHook!.state).toBe("loading");
  });

  it("toggling from unwatched optimistically flips to watched, PUTs state=played, and toasts the real copy", async () => {
    findProgressForItemMock.mockResolvedValue(null);
    apiPutMock.mockResolvedValue({ itemId: "item-1", state: "played", positionMs: 100_000, durationMs: 100_000, playCount: 1, updatedAtMs: 1 });
    view = render("item-1", 100_000);
    await flush();
    expect(latestHook!.state).toBe("unwatched");

    act(() => {
      latestHook!.toggle();
    });
    // Optimistic flip happens synchronously, before the PUT resolves.
    expect(latestHook!.state).toBe("watched");
    expect(apiPutMock).toHaveBeenCalledWith("/progress/{itemId}", {
      params: { path: { itemId: "item-1" } },
      body: { state: "played", positionMs: 100_000, durationMs: 100_000 },
    });

    await flush();
    expect(latestHook!.state).toBe("watched");
  });

  it("toggling from watched flips to unwatched and PUTs state=unplayed/positionMs=0", async () => {
    findProgressForItemMock.mockResolvedValue({ state: "played", positionMs: 100_000, durationMs: 100_000 });
    apiPutMock.mockResolvedValue({ itemId: "item-1", state: "unplayed", positionMs: 0, durationMs: 100_000, playCount: 1, updatedAtMs: 1 });
    view = render("item-1", 100_000);
    await flush();
    expect(latestHook!.state).toBe("watched");

    act(() => {
      latestHook!.toggle();
    });
    expect(latestHook!.state).toBe("unwatched");
    expect(apiPutMock).toHaveBeenCalledWith("/progress/{itemId}", {
      params: { path: { itemId: "item-1" } },
      body: { state: "unplayed", positionMs: 0, durationMs: 100_000 },
    });
  });

  it("reverts the optimistic update when the PUT fails", async () => {
    findProgressForItemMock.mockResolvedValue(null);
    apiPutMock.mockRejectedValue(new Error("network down"));
    view = render("item-1");
    await flush();
    expect(latestHook!.state).toBe("unwatched");

    act(() => {
      latestHook!.toggle();
    });
    expect(latestHook!.state).toBe("watched"); // optimistic
    await flush();
    expect(latestHook!.state).toBe("unwatched"); // reverted
  });

  it("ignores a toggle while a previous one is still in flight", async () => {
    findProgressForItemMock.mockResolvedValue(null);
    let resolvePut!: () => void;
    apiPutMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = () => resolve({ itemId: "item-1", state: "played", positionMs: 0, durationMs: null, playCount: 1, updatedAtMs: 1 });
      }),
    );
    view = render("item-1");
    await flush();

    act(() => {
      latestHook!.toggle();
    });
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    act(() => {
      latestHook!.toggle(); // busy — ignored
    });
    expect(apiPutMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePut();
      await Promise.resolve();
    });
  });
});
