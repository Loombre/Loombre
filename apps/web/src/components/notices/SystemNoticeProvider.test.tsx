// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/notices/SystemNoticeProvider.test.tsx
//
// Provider-level coverage of the state machine itself (NG2/NG3/NG10):
// boot fetch + skewed-clock offset, live publish/cancel semantics,
// per-session dismiss + reconnect reconciliation, offset-corrected expiry
// auto-clear, and the once-per-id info toast. Rendered-countdown text
// (the "SKEWED CLOCK: renders from server truth" exit-gate line) gets its
// end-to-end coverage in BannerRegion.test.tsx; this file pins the state
// this and every other consumer reads.
//
// Harness follows MailSection.test.tsx's mock shape (api-client,
// events-socket) and ServerPowerCard.test.tsx's fake-timer style. useToast
// is mocked directly (not a real <ToastProvider>) so the once-per-id
// assertion can count calls precisely instead of inferring it from DOM
// text, which can't distinguish "toasted once" from "toasted twice with
// the same message".

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const showToastMock = vi.fn();

let authenticated = true;
const authListeners = new Set<() => void>();

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    subscribe: (fn: () => void) => {
      authListeners.add(fn);
      return () => authListeners.delete(fn);
    },
  }),
}));

// A STABLE object reference, matching the real ToastProvider's own
// useMemo(() => ({ showToast, dismiss }), [...]) — a fresh object/function
// per render here would make every callback that depends on `showToast`
// (fetchActive -> applyActive -> maybeToastInfo) re-identity every render
// too, which would re-run the boot effect in a loop. That's a test-harness
// concern only; the real ToastProvider is already stable this way.
const toastValue = { showToast: (...args: unknown[]) => showToastMock(...args), dismiss: vi.fn() };
vi.mock("../ui/Toast.js", () => ({
  useToast: () => toastValue,
}));

type SocketListener = (event: { tsMs: number; payload: unknown }) => void;
type StatusListener = (status: "open" | "closed" | "connecting") => void;

const socketListeners = new Map<string, Set<SocketListener>>();
const statusListeners = new Set<StatusListener>();

function emit(type: string, event: { tsMs: number; payload: unknown }): void {
  const set = socketListeners.get(type);
  if (!set) return;
  for (const listener of Array.from(set)) listener(event);
}

function emitStatus(status: "open" | "closed" | "connecting"): void {
  for (const listener of Array.from(statusListeners)) listener(status);
}

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({
    subscribe: (type: string, listener: SocketListener) => {
      let set = socketListeners.get(type);
      if (!set) {
        set = new Set();
        socketListeners.set(type, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    onStatusChange: (listener: StatusListener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  }),
}));

const { SystemNoticeProvider, useSystemNotice } = await import("./SystemNoticeProvider.js");
type SystemNotice = import("./SystemNoticeProvider.js").SystemNotice;

function makeNotice(overrides: Partial<SystemNotice> = {}): SystemNotice {
  return {
    id: "notice-1",
    message: "Server restarting for maintenance",
    severity: "warning",
    effectiveAtMs: null,
    expiresAtMs: null,
    createdAtMs: 0,
    ...overrides,
  };
}

function Probe(): React.JSX.Element {
  const { notice, severity, dismissed, dismiss, serverOffsetMs, bannerVisible } = useSystemNotice();
  return (
    <div>
      <span data-testid="id">{notice?.id ?? ""}</span>
      <span data-testid="message">{notice?.message ?? ""}</span>
      <span data-testid="severity">{severity ?? ""}</span>
      <span data-testid="dismissed">{String(dismissed)}</span>
      <span data-testid="bannerVisible">{String(bannerVisible)}</span>
      <span data-testid="offset">{String(serverOffsetMs)}</span>
      <button type="button" onClick={dismiss}>
        dismiss
      </button>
    </div>
  );
}

function field(view: TestRender, testid: string): string {
  return view.container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

async function renderProvider(): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderIntoBody(
      <SystemNoticeProvider>
        <Probe />
      </SystemNoticeProvider>,
    );
  });
  if (!view) throw new Error("render produced nothing");
  return view;
}

describe("SystemNoticeProvider", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    showToastMock.mockReset();
    authenticated = true;
    authListeners.clear();
    socketListeners.clear();
    statusListeners.clear();
    apiGetMock.mockResolvedValue({ notice: null, serverNowMs: Date.now() });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("boot fetch anchors serverOffsetMs from serverNowMs, correcting a skewed local clock", async () => {
    vi.useFakeTimers();
    const localNow = 1_700_000_000_000;
    vi.setSystemTime(localNow);
    const serverNow = localNow + 10 * 60_000; // server clock 10min AHEAD of this client's own
    apiGetMock.mockResolvedValue({ notice: makeNotice({ id: "boot-1" }), serverNowMs: serverNow });

    view = await renderProvider();
    await act(async () => {});

    expect(field(view, "id")).toBe("boot-1");
    expect(field(view, "offset")).toBe(String(10 * 60_000));
  });

  it("on active-fetch null, the held notice clears", async () => {
    apiGetMock.mockResolvedValue({ notice: makeNotice({ id: "will-clear" }), serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "id")).toBe("will-clear");

    apiGetMock.mockResolvedValue({ notice: null, serverNowMs: Date.now() });
    await act(async () => {
      emitStatus("open"); // triggers a refetch (NG2)
    });
    await act(async () => {});
    expect(field(view, "id")).toBe("");
  });

  it("on active-fetch FAILURE, keeps showing whatever is already held (a mid-restart server must not blank the banner)", async () => {
    apiGetMock.mockResolvedValue({ notice: makeNotice({ id: "held" }), serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "id")).toBe("held");

    apiGetMock.mockRejectedValue(new Error("network down"));
    await act(async () => {
      emitStatus("open");
    });
    await act(async () => {});
    expect(field(view, "id")).toBe("held");
  });

  it("notice.published REPLACES the held notice (different id) and re-arms visibility (clears dismiss)", async () => {
    view = await renderProvider();
    await act(async () => {});

    await act(async () => {
      emit("notice.published", { tsMs: Date.now(), payload: makeNotice({ id: "A", severity: "warning" }) });
    });
    expect(field(view, "id")).toBe("A");
    expect(field(view, "bannerVisible")).toBe("true");

    view.container.querySelector("button")!.click();
    await act(async () => {});
    expect(field(view, "dismissed")).toBe("true");
    expect(field(view, "bannerVisible")).toBe("false");

    await act(async () => {
      emit("notice.published", { tsMs: Date.now(), payload: makeNotice({ id: "B", severity: "warning" }) });
    });
    expect(field(view, "id")).toBe("B");
    expect(field(view, "dismissed")).toBe("false");
    expect(field(view, "bannerVisible")).toBe("true");
  });

  it("notice.cancelled with a matching id clears; a stale id is a no-op", async () => {
    view = await renderProvider();
    await act(async () => {
      emit("notice.published", { tsMs: Date.now(), payload: makeNotice({ id: "live" }) });
    });
    expect(field(view, "id")).toBe("live");

    await act(async () => {
      emit("notice.cancelled", { tsMs: Date.now(), payload: { id: "some-other-id" } });
    });
    expect(field(view, "id")).toBe("live"); // stale id — no-op

    await act(async () => {
      emit("notice.cancelled", { tsMs: Date.now(), payload: { id: "live" } });
    });
    expect(field(view, "id")).toBe("");
  });

  it("dismiss hides the banner; a reconnect that refetches the SAME still-active notice brings it back (N3)", async () => {
    const NOTICE = makeNotice({ id: "still-active", severity: "warning" });
    apiGetMock.mockResolvedValue({ notice: NOTICE, serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "bannerVisible")).toBe("true");

    view.container.querySelector("button")!.click();
    await act(async () => {});
    expect(field(view, "dismissed")).toBe("true");
    expect(field(view, "bannerVisible")).toBe("false");

    // Reconnect: the SAME notice is still active server-side.
    await act(async () => {
      emitStatus("open");
    });
    await act(async () => {});
    expect(field(view, "id")).toBe("still-active");
    expect(field(view, "dismissed")).toBe("false");
    expect(field(view, "bannerVisible")).toBe("true");
  });

  it("critical severity computes bannerVisible=true with no dismiss having occurred", async () => {
    apiGetMock.mockResolvedValue({ notice: makeNotice({ id: "crit", severity: "critical" }), serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "severity")).toBe("critical");
    expect(field(view, "bannerVisible")).toBe("true");
  });

  it("ZERO-STATE / expiry auto-clear: a timer (not a poll) clears the notice once offset-corrected now passes expiresAtMs", async () => {
    vi.useFakeTimers();
    const localNow = 1_700_000_000_000;
    vi.setSystemTime(localNow);
    const serverNow = localNow; // no skew, keep the arithmetic simple
    apiGetMock.mockResolvedValue({
      notice: makeNotice({ id: "expiring", expiresAtMs: serverNow + 5000 }),
      serverNowMs: serverNow,
    });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "id")).toBe("expiring");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(field(view, "id")).toBe("expiring"); // not yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(field(view, "id")).toBe(""); // cleared at/after the target, never lingering
  });

  it("critical severity with expiresAtMs=null (NG4: legal only for critical) never schedules a clear", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({
      notice: makeNotice({ id: "until-cancelled", severity: "critical", expiresAtMs: null }),
      serverNowMs: Date.now(),
    });
    view = await renderProvider();
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); // a full day
    });
    expect(field(view, "id")).toBe("until-cancelled");
  });

  it("info severity toasts once per id, including via the boot fetch — a reconnect refetch of the SAME id never re-toasts", async () => {
    const INFO = makeNotice({ id: "info-1", severity: "info", message: "Heads up" });
    apiGetMock.mockResolvedValue({ notice: INFO, serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith("Heads up", { variant: "accent" });

    await act(async () => {
      emitStatus("open"); // refetch returns the SAME still-active info notice
    });
    await act(async () => {});
    expect(showToastMock).toHaveBeenCalledTimes(1);

    // A genuinely NEW info notice toasts again (new id).
    await act(async () => {
      emit("notice.published", { tsMs: Date.now(), payload: makeNotice({ id: "info-2", severity: "info", message: "Second" }) });
    });
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock).toHaveBeenLastCalledWith("Second", { variant: "accent" });
  });

  it("info severity never sets bannerVisible", async () => {
    apiGetMock.mockResolvedValue({ notice: makeNotice({ id: "info-only", severity: "info" }), serverNowMs: Date.now() });
    view = await renderProvider();
    await act(async () => {});
    expect(field(view, "bannerVisible")).toBe("false");
  });

  it("R-F1: a stale /notices/active response resolving AFTER a socket publish is DISCARDED — never clobbers the newer notice", async () => {
    view = await renderProvider();
    await act(async () => {});

    // The next fetch (reconnect-triggered) hangs until we resolve it — the
    // review's live repro: a slow /notices/active while the server is
    // mid-restart, exactly this feature's primary scenario.
    let resolveStale: (v: unknown) => void = () => {};
    apiGetMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    await act(async () => {
      emitStatus("open");
    });

    await act(async () => {
      emit("notice.published", { tsMs: Date.now(), payload: makeNotice({ id: "NEW" }) });
    });
    expect(field(view, "id")).toBe("NEW");

    await act(async () => {
      resolveStale({ notice: makeNotice({ id: "OLD" }), serverNowMs: Date.now() });
    });
    expect(field(view, "id")).toBe("NEW"); // the stale snapshot must lose
  });

  it("R-F1 (resurrect variant): a cancel arriving mid-fetch stops the fetch from re-applying the just-cancelled notice", async () => {
    view = await renderProvider();
    await act(async () => {});

    let resolveStale: (v: unknown) => void = () => {};
    apiGetMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    await act(async () => {
      emitStatus("open");
    });

    // Cancel an id we don't even hold yet — the in-flight fetch is about
    // to return exactly this notice; the bump must be unconditional.
    await act(async () => {
      emit("notice.cancelled", { tsMs: Date.now(), payload: { id: "GHOST" } });
    });

    await act(async () => {
      resolveStale({ notice: makeNotice({ id: "GHOST" }), serverNowMs: Date.now() });
    });
    expect(field(view, "id")).toBe(""); // the ghost stays buried
  });
});
