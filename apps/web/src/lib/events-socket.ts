// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/events-socket.ts
//
// Typed client for the server's WS /v1/events broadcaster
// (apps/server/src/gateway/ws-broadcaster.service.ts). Connects with
// `?token=<accessJWT>` (query param — matches the server's `extractToken`),
// re-derives a fresh token from the AuthStore on every (re)connect attempt
// (so a proactive refresh mid-outage is honored automatically), and
// reconnects with exponential backoff + jitter, capped, on any close/error.
//
// Envelope shape (packages/contract/event-schemas/envelope.schema.json):
// { id, type, tsMs, actorUserId, payload }. `type` is a closed enum on the
// server today, but this client treats it as an open string and silently
// ignores anything it doesn't recognize or that fails to parse as JSON —
// CONCURRENCY note: a separate server lane is landing new event types
// (restricted.locked/unlocked, playback.progress) alongside this work, so
// unknown/malformed frames must degrade gracefully, never throw.
//
// This is the ONE shared WS client for the app (P2.8 instruction: "keep it
// clean") — restricted-lock state and the music now-playing pulse both
// subscribe through `getEventsSocket()` rather than opening their own
// sockets.

import { getAuthStore } from "./auth-store.js";

export interface EventEnvelope<TPayload = unknown> {
  id: string;
  type: string;
  tsMs: number;
  actorUserId: string | null;
  payload: TPayload;
}

export type EventListener<TPayload = unknown> = (event: EventEnvelope<TPayload>) => void;
export type SocketStatus = "closed" | "connecting" | "open";
export type StatusListener = (status: SocketStatus) => void;

/** Minimal WebSocket surface this module depends on — lets tests inject a
 *  fake implementation without touching the real global. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface EventsSocketOptions {
  getServerUrl: () => string;
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  WebSocketImpl?: WebSocketCtor;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
const JITTER_RATIO = 0.2;

/** http(s) origin -> ws(s) origin, path appended; no `/v1` segment (see
 *  api-client.ts's header — the real server mounts bare paths). */
function toEventsUrl(serverUrl: string, token: string): string {
  const wsOrigin = serverUrl.replace(/\/$/, "").replace(/^http/i, (m) => (m === "http" ? "ws" : "wss"));
  return `${wsOrigin}/v1/events?token=${encodeURIComponent(token)}`;
}

export class EventsSocket {
  private ws: WebSocketLike | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly wildcardListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = true;
  private status: SocketStatus = "closed";
  private connectToken = 0;

  constructor(private readonly options: EventsSocketOptions) {}

  getStatus(): SocketStatus {
    return this.status;
  }

  /** Idempotent: calling connect() while already connecting/open is a no-op
   *  besides clearing any pending reconnect backoff. */
  connect(): void {
    if (!this.closedByUser && (this.ws !== null || this.reconnectTimer !== null)) return;
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectToken += 1; // invalidate any in-flight open() attempt
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus("closed");
  }

  private async open(): Promise<void> {
    if (this.closedByUser) return;
    const myToken = ++this.connectToken;

    const serverUrl = this.options.getServerUrl();
    if (!serverUrl) {
      this.scheduleReconnect();
      return;
    }

    let accessToken: string | null | undefined;
    try {
      accessToken = await this.options.getToken();
    } catch {
      accessToken = null;
    }
    if (this.closedByUser || myToken !== this.connectToken) return; // superseded/cancelled while awaiting the token
    if (!accessToken) {
      this.scheduleReconnect();
      return;
    }

    this.setStatus("connecting");
    const Impl = this.options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    let ws: WebSocketLike;
    try {
      ws = new Impl(toEventsUrl(serverUrl, accessToken));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (myToken !== this.connectToken) return;
      this.reconnectAttempts = 0;
      this.setStatus("open");
    };
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onclose = () => {
      if (myToken !== this.connectToken) return;
      this.ws = null;
      this.setStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // already closed/closing — nothing to do.
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const exp = Math.min(BASE_DELAY_MS * 2 ** this.reconnectAttempts, MAX_DELAY_MS);
    const jitter = exp * JITTER_RATIO * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(exp + jitter));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return; // defensive: binary/unexpected frame shapes are ignored, not thrown
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string"
    ) {
      return; // malformed/unrecognized envelope — degrade gracefully (CONCURRENCY note above)
    }
    const event = parsed as EventEnvelope;
    const specific = this.listeners.get(event.type);
    if (specific) for (const listener of specific) listener(event);
    for (const listener of this.wildcardListeners) listener(event);
  }

  /** Subscribe to exactly one event `type` (e.g. "restricted.locked"). */
  subscribe<TPayload = unknown>(type: string, listener: EventListener<TPayload>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as EventListener);
    return () => set!.delete(listener as EventListener);
  }

  /** Subscribe to every event, regardless of type. */
  subscribeAll(listener: EventListener): () => void {
    this.wildcardListeners.add(listener);
    return () => this.wildcardListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

let singleton: EventsSocket | undefined;

/** Lazily built against the live AuthStore — import cost stays zero until a
 *  consumer actually asks for the socket (mirrors getAuthStore()/getClient()). */
export function getEventsSocket(): EventsSocket {
  if (!singleton) {
    singleton = new EventsSocket({
      getServerUrl: () => getAuthStore().getSnapshot().serverUrl,
      getToken: () => getAuthStore().getAccessToken(),
    });
  }
  return singleton;
}

/** Test-only escape hatch: replace the module singleton (used by
 *  components' tests that need a fresh EventsSocket instance per test). */
export function __setEventsSocketForTests(socket: EventsSocket | undefined): void {
  singleton = socket;
}
