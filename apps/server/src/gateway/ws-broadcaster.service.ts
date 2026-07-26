// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/ws-broadcaster.service.ts
//
// WS endpoint at /v1/events on the SAME HTTP server (mission deliverable H
// delivery half). Connect with `?token=<access JWT>` (query param) or the
// Sec-WebSocket-Protocol header (`Bearer, <token>` — browsers cannot set
// arbitrary headers on a WebSocket handshake, so this is the header-based
// fallback the mission text calls for); validated exactly like AuthGuard
// (same TokenService.verifyAccessToken), then a ViewerContext is resolved
// per connection via ViewerContextProvider (P1.14's five-gate resolution —
// no separate copy of that logic here).
//
// Broadcaster loop (single-process v1, documented limitation — see
// packages/db/src/query/events.ts's markEventsProcessed doc comment):
// every 500ms, poll the outbox for events['processed_at_ms IS NULL'] in
// batches of 100 ordered by id (readUnprocessedEvents). For each currently
// connected socket, RE-RESOLVE that socket's ViewerContext if its cached
// copy is more than 5s old (mission spec: "an expired unlock must stop
// restricted deliveries mid-connection"), then filter the batch through
// filterEventsForViewer(db, ctx, ids) — the SAME visibility predicate
// readEventsForViewer's HTTP-polling cousin uses (packages/db/src/query/
// events.ts) — and send each envelope-shaped survivor
// (packages/contract/event-schemas/envelope.schema.json) over the socket.
// The whole polled batch is marked processed once every connected socket
// has had its chance at it, regardless of whether any of them were
// actually cleared to see any given row.
//
// IMPORTANT (P2.8 fix): the per-socket ViewerContext staleness check runs
// EVERY tick for EVERY connected socket, independent of whether there is
// an unprocessed outbox batch to deliver. Earlier code short-circuited the
// whole poll() body (`if (batch.length === 0) return`) whenever the outbox
// was empty, which meant a socket's ctx was NEVER re-resolved during any
// quiet period with no catalog/scan/playback activity — silently
// defeating the mission's "auto-relock reflects instantly via websocket"
// requirement (P2.8) for the common case of a server that is otherwise
// idle. Context re-resolution and outbox-batch delivery are now two
// independent halves of the same tick.
//
// Restricted auto-relock synthesis (P2.8, task 3c): when a socket's
// re-resolved ViewerContext transitions restrictedCleared true -> false,
// this service sends that socket a LOCALLY SYNTHESIZED `restricted.locked`
// envelope — never written to the events outbox table. Two reasons:
//   1. There is no discrete "lock" action to attach an outbox row to: the
//      unlock simply timed out (user_settings.restricted_unlocked_until_ms
//      fell into the past between two ctx resolutions) — nothing else in
//      the system needs to know this happened, only this user's own
//      sockets, and only right now.
//   2. An explicit POST /restricted/lock (packages/db/src/query/
//      identity.ts's setRestrictedUnlockUntilAndEmit) already gets a REAL
//      outbox `restricted.locked` row, delivered via the USER_ONLY_TYPES
//      branch below independent of ctx staleness. If that explicit lock's
//      DB write happens to land in the same window as this socket's ctx
//      staleness check, the transition detected here fires TOO — the
//      socket receives `restricted.locked` twice. This is a deliberate,
//      accepted tradeoff (documented, not a bug): distinguishing "expired"
//      from "explicitly locked" here would require ViewerContext itself to
//      carry the reason a clearance changed, which it does not today and
//      is not worth adding for a harmless, idempotent duplicate (a second
//      lock signal to an already-locked client is a no-op).
//
// Registered in GatewayModule (this directory), which already imports
// SessionModule for AuthGuard's TokenService — this service reuses that
// same import, plus CommonModule (via SessionModule's re-export) for
// ViewerContextProvider/DbProvider. Gateway is exempt from the D2
// catalog/playback/session pairwise-import ban (see common/common.module.ts
// and session/session.module.ts's headers), so this is not a boundary
// violation.
//
// ADMIN_ONLY_TYPES delivery (STATE.md P4.13, Phase 4 deliverable D): the
// admin jobs dashboard's live updates ('job.updated') must reach ONLY
// admin-context sockets — mirrors USER_ONLY_TYPES's naming/intent
// (packages/db/src/query/events.ts) but is implemented HERE, not in that
// query-layer module, because "is this socket an admin" is not a question
// ViewerContext answers (it has no isAdmin field — see packages/db/src/
// context.ts's header: it resolves the five-gate restricted-content
// clearance only) and adding one would widen that type's contract for
// every guarded catalog read in the codebase for the sake of one non-
// content event type. `isAdmin` is instead read straight off the
// connection's own verified AccessTokenClaims (the same claim
// gateway/auth.guard.ts's REST guard trusts for `req.user.isAdmin`) and
// cached for the socket's lifetime — admission status changing mid-
// connection is the same accepted tradeoff the REST guard already makes
// for the token's short (15 min) lifetime, not a new one introduced here.
// filterEventsForViewer still runs first (job.updated has no item/library/
// user association, so it "passes through unfiltered" per that function's
// own doc comment); this is an ADDITIONAL filter layered on top, entirely
// within this broadcaster.

import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { filterEventsForViewer, markEventsProcessed, readUnprocessedEvents, type ViewerContext } from "@loombre/db";
import { uuidv7 } from "@loombre/shared";
import { TokenService, type AccessTokenClaims } from "../session/token.service.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { ADMIN_ONLY_EVENT_TYPES } from "../plugins/event-taxonomy.js";

const EVENTS_PATH = "/v1/events";
const POLL_INTERVAL_MS = 500;
const POLL_BATCH_SIZE = 100;
/** Mission spec: "cache context per socket for <=5s max". */
const CONTEXT_CACHE_TTL_MS = 5000;

/** Event `type`s delivered ONLY to sockets whose connecting user is an
 *  admin (this file's header, "ADMIN_ONLY_TYPES delivery"). `settings.updated`
 *  (STATE.md Addendum A/A5) registers here for the exact same reason
 *  job.updated does: it carries no item/library/user association for
 *  packages/db/src/query/events.ts's visibility predicate to gate on, and
 *  an admin-configuration change is not something any non-admin viewer
 *  should learn about via the live event stream. The six `plugin.*` types
 *  (LPP v1, Lane W2/LD4) register here for the identical reason — plugin
 *  registration/lifecycle/health is instance administration, not
 *  content-scoped catalog data.
 *
 *  H-4 fix wave: this is now imported from apps/server/src/plugins/
 *  event-taxonomy.ts's `ADMIN_ONLY_EVENT_TYPES`, which is ALSO the set
 *  `getOutboxEventTaxonomy()` excludes from what a plugin manifest may even
 *  request — one classification, two enforcement points (WS delivery to
 *  users here; plugin grant/delivery there), never two copies that could
 *  drift apart. */
const ADMIN_ONLY_TYPES: readonly string[] = ADMIN_ONLY_EVENT_TYPES;

interface SocketState {
  userId: string;
  isAdmin: boolean;
  ctx: ViewerContext;
  ctxResolvedAtMs: number;
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;

  const protocolHeader = req.headers["sec-websocket-protocol"];
  const raw = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;
  if (typeof raw !== "string") return undefined;
  // Sec-WebSocket-Protocol is a comma-separated list; convention here is
  // `bearer, <token>` (two protocol tokens — commas separate list entries
  // in the header grammar, so the token itself must not contain one).
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length >= 2 && parts[0]?.toLowerCase() === "bearer") {
    return parts[1];
  }
  return undefined;
}

@Injectable()
export class WsBroadcasterService implements OnApplicationBootstrap, OnModuleDestroy {
  private wss: WebSocketServer | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly sockets = new Map<WebSocket, SocketState>();

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly tokenService: TokenService,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly dbProvider: DbProvider,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://internal.invalid");
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== EVENTS_PATH) {
        // Not our path — nothing else in this server handles upgrades, so
        // there is no other handler to defer to; destroy defensively
        // rather than leaving the socket to hang forever.
        socket.destroy();
        return;
      }

      const token = extractToken(req, url);
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.tokenService
        .verifyAccessToken(token)
        .then((claims) => {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit("connection", ws, claims);
          });
        })
        .catch(() => {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
        });
    });

    this.wss.on("connection", (ws: WebSocket, claims: AccessTokenClaims) => {
      void (async () => {
        const nowMs = Date.now();
        try {
          const ctx = await this.viewerContextProvider.resolve(claims.sub, nowMs);
          this.sockets.set(ws, { userId: claims.sub, isAdmin: claims.isAdmin, ctx, ctxResolvedAtMs: nowMs });
        } catch {
          // Fail-closed: if the initial context can't be resolved, the
          // socket is never added to the delivery map (it receives
          // nothing), but it must still be CLOSED rather than left dangling
          // as a leaked half-open connection.
          ws.close();
        }
      })();

      ws.on("close", () => this.sockets.delete(ws));
      ws.on("error", () => this.sockets.delete(ws));
    });

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.sockets.size === 0) return;

    const db = this.dbProvider.db;
    const nowMs = Date.now();

    // Independent of whether there's anything to deliver this tick — see
    // this file's header ("IMPORTANT (P2.8 fix)") for why ctx staleness
    // can no longer be gated behind "is the outbox batch non-empty".
    const batch = await readUnprocessedEvents(db, POLL_BATCH_SIZE);
    const ids = batch.map((e) => e.id);

    for (const [ws, state] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      let ctx = state.ctx;
      if (nowMs - state.ctxResolvedAtMs > CONTEXT_CACHE_TTL_MS) {
        const wasCleared = state.ctx.restrictedCleared;
        ctx = await this.viewerContextProvider.resolve(state.userId, nowMs);
        state.ctx = ctx;
        state.ctxResolvedAtMs = nowMs;

        if (wasCleared && !ctx.restrictedCleared) {
          // Restricted auto-relock synthesis — see this file's header for
          // why this is never written to the outbox and why an occasional
          // duplicate alongside an explicit lock's real outbox event is an
          // accepted tradeoff.
          this.sendRestrictedLocked(ws, state.userId, nowMs);
        }
      }

      if (ids.length > 0) {
        const visible = await filterEventsForViewer(db, ctx, ids);
        for (const ev of visible) {
          // ADMIN_ONLY_TYPES (this file's header): job.updated never
          // reaches a non-admin socket, independent of (and in addition
          // to) the content-visibility filter above.
          if (ADMIN_ONLY_TYPES.includes(ev.type) && !state.isAdmin) continue;
          ws.send(
            JSON.stringify({
              id: ev.id,
              type: ev.type,
              tsMs: ev.ts_ms,
              actorUserId: ev.actor_user_id,
              payload: ev.payload,
            }),
          );
        }
      }
    }

    if (ids.length > 0) {
      await markEventsProcessed(db, ids, nowMs);
    }
  }

  private sendRestrictedLocked(ws: WebSocket, userId: string, nowMs: number): void {
    ws.send(
      JSON.stringify({
        id: uuidv7(nowMs),
        type: "restricted.locked",
        tsMs: nowMs,
        actorUserId: userId,
        payload: { userId },
      }),
    );
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const ws of this.sockets.keys()) {
      ws.close();
    }
    this.sockets.clear();
    this.wss?.close();
  }
}
