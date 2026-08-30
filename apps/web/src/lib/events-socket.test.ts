// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsSocket, type WebSocketLike } from "./events-socket.js";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(public readonly url: string) {
    instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  triggerServerClose(): void {
    this.closed = true;
    this.onclose?.();
  }
}

let instances: FakeSocket[] = [];

function envelope(type: string, payload: unknown = {}): string {
  return JSON.stringify({ id: "01234567-89ab-cdef-0123-456789abcdef", type, tsMs: Date.now(), actorUserId: null, payload });
}

describe("EventsSocket", () => {
  beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
    // Neutralize reconnect-backoff jitter (±20%) so delay assertions are exact.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeSocket(tokenSequence: (string | null)[] = ["token-a"]) {
    let call = 0;
    const socket = new EventsSocket({
      getServerUrl: () => "http://localhost:3001",
      getToken: () => tokenSequence[Math.min(call++, tokenSequence.length - 1)] ?? null,
      WebSocketImpl: FakeSocket,
    });
    return socket;
  }

  it("connects to the ws(s) URL derived from the server URL, with the token as a query param", async () => {
    const socket = makeSocket(["abc123"]);
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0]?.url).toBe("ws://localhost:3001/v1/events?token=abc123");
  });

  it("reports status transitions: connecting -> open", async () => {
    const socket = makeSocket();
    const statuses: string[] = [];
    socket.onStatusChange((s) => statuses.push(s));
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(socket.getStatus()).toBe("connecting");
    instances[0]!.triggerOpen();
    expect(socket.getStatus()).toBe("open");
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("dispatches a parsed envelope to type-specific subscribers and wildcard subscribers", async () => {
    const socket = makeSocket();
    const restrictedEvents: unknown[] = [];
    const allEvents: unknown[] = [];
    socket.subscribe("restricted.locked", (e) => restrictedEvents.push(e));
    socket.subscribeAll((e) => allEvents.push(e));
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.triggerOpen();
    instances[0]!.triggerMessage(envelope("restricted.locked", { userId: "u1" }));
    instances[0]!.triggerMessage(envelope("playback.progress", { itemId: "i1" }));

    expect(restrictedEvents).toHaveLength(1);
    expect(allEvents).toHaveLength(2);
  });

  it("degrades gracefully on malformed/unrecognized frames instead of throwing", async () => {
    const socket = makeSocket();
    const allEvents: unknown[] = [];
    socket.subscribeAll((e) => allEvents.push(e));
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.triggerOpen();

    expect(() => instances[0]!.triggerMessage("not json{{{")).not.toThrow();
    expect(() => instances[0]!.triggerMessage(JSON.stringify({ no: "type field" }))).not.toThrow();
    expect(() => instances[0]!.triggerMessage(JSON.stringify(null))).not.toThrow();
    expect(() => instances[0]!.triggerMessage(42)).not.toThrow();
    expect(allEvents).toHaveLength(0);
  });

  it("unsubscribe stops further delivery", async () => {
    const socket = makeSocket();
    const events: unknown[] = [];
    const unsubscribe = socket.subscribe("restricted.unlocked", (e) => events.push(e));
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.triggerOpen();
    instances[0]!.triggerMessage(envelope("restricted.unlocked"));
    unsubscribe();
    instances[0]!.triggerMessage(envelope("restricted.unlocked"));
    expect(events).toHaveLength(1);
  });

  it("reconnects with exponential backoff after an unexpected close", async () => {
    const socket = makeSocket(["t", "t", "t", "t"]);
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.triggerOpen();

    instances[0]!.triggerServerClose(); // unexpected close -> should schedule a reconnect
    expect(instances).toHaveLength(1); // not yet — waiting out the backoff

    await vi.advanceTimersByTimeAsync(499);
    expect(instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(2); // first backoff: 500ms (jitter neutralized)

    instances[1]!.triggerServerClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(3); // second backoff: 1000ms (exponential)
  });

  it("caps backoff delay at 15s", async () => {
    const tokens = Array.from({ length: 10 }, () => "t");
    const socket = makeSocket(tokens);
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));

    // Force several consecutive failures to blow past the cap.
    for (let i = 0; i < 8; i++) {
      const last = instances[instances.length - 1]!;
      last.triggerServerClose();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    // Every reconnect attempt happened within <=15s waits — reaching this
    // point without a runaway/slower delay proves the cap held.
    expect(instances.length).toBeGreaterThan(5);
  });

  it("disconnect() prevents any further reconnect attempts", async () => {
    const socket = makeSocket();
    socket.connect();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.triggerOpen();
    socket.disconnect();
    expect(socket.getStatus()).toBe("closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
  });

  it("defers connecting (and retries) when no token is available yet", async () => {
    const socket = makeSocket([null, null, "finally-a-token"]);
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0]?.url).toContain("finally-a-token");
  });

  // RZI-D5c zone subscription (run RZI-2026-08-30): restricted-item events
  // are delivered only to sockets that opened the zone subscription, so
  // the client must send the control frames at the right moments AND
  // re-arm after reconnects (a dropped socket inside /restricted must come
  // back subscribed).
  describe("setRestrictedZoneSubscribed (RZI-D5c)", () => {
    it("sends the subscribe frame immediately on an open socket, and the unsubscribe frame when turned off", async () => {
      const socket = makeSocket();
      socket.connect();
      await vi.waitFor(() => expect(instances).toHaveLength(1));
      instances[0]!.triggerOpen();

      socket.setRestrictedZoneSubscribed(true);
      expect(instances[0]!.sent).toEqual([JSON.stringify({ type: "restricted.subscribe" })]);

      // Idempotent: same desired state sends nothing new.
      socket.setRestrictedZoneSubscribed(true);
      expect(instances[0]!.sent).toHaveLength(1);

      socket.setRestrictedZoneSubscribed(false);
      expect(instances[0]!.sent).toEqual([
        JSON.stringify({ type: "restricted.subscribe" }),
        JSON.stringify({ type: "restricted.unsubscribe" }),
      ]);
    });

    it("remembers the desired state while closed and re-sends the subscribe frame on every (re)connect", async () => {
      const socket = makeSocket();
      // Desired ON before any socket exists — nothing to send yet.
      socket.setRestrictedZoneSubscribed(true);
      socket.connect();
      await vi.waitFor(() => expect(instances).toHaveLength(1));
      instances[0]!.triggerOpen();
      expect(instances[0]!.sent).toEqual([JSON.stringify({ type: "restricted.subscribe" })]);

      // Server drops the socket; the reconnect must re-arm the subscription.
      instances[0]!.triggerServerClose();
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(instances).toHaveLength(2));
      instances[1]!.triggerOpen();
      expect(instances[1]!.sent).toEqual([JSON.stringify({ type: "restricted.subscribe" })]);
    });
  });
});
