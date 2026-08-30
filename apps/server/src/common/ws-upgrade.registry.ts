// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/ws-upgrade.registry.ts
//
// Remote-access verification finding (2026-08-30): the /v1/events WS
// upgrade handler (gateway/ws-broadcaster.service.ts) was attached ONLY to
// the http.Server NestFactory creates — but that is not the only server
// that fronts the Express app. Two deployment shapes serve requests from a
// DIFFERENT server object with no "upgrade" listener at all, so Node
// destroyed every WS handshake and live events silently died on exactly
// the paths that ARE remote access:
//   - built-in TLS (main.ts's listenWithTls branch): a separate
//     https.Server from tls/runtime.ts,
//   - the Loombre Remote WireGuard path (RG2): a separate loopback-only
//     http.Server the tunnel raw-TCP-pipes to
//     (remote/wireguard/remote-wireguard.service.ts's backend listener).
//
// This registry is the one seam joining them: the broadcaster registers
// its upgrade handler here (exactly once, at its own bootstrap), and every
// server-owning site — the broadcaster itself for Nest's server, main.ts
// for the TLS server, RemoteWireguardService for each WG backend listener
// — calls attach(). Ordering is NOT guaranteed between those sites
// (RemoteWireguardService's boot-resume and WsBroadcasterService are both
// onApplicationBootstrap hooks, and their relative order is module-graph
// trivia nobody should depend on), so attach() before setHandler() queues
// the server and setHandler() drains the queue — a pending server that got
// closed in the meantime is harmless to attach to (a closed server emits
// no upgrade events).
//
// Provided by CommonModule ONLY (the standing re-provided-service DI
// lesson: a second module-scoped instance would silently split the
// pending queue from the handler).

import { Injectable } from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Matches the ("upgrade") event signature shared by http.Server and
 *  https.Server — the registry never cares which one it is given. */
export interface UpgradeCapableServer {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

@Injectable()
export class WsUpgradeRegistry {
  private handler: UpgradeHandler | null = null;
  private pendingServers: UpgradeCapableServer[] = [];

  /** Called exactly once, by WsBroadcasterService. Drains any servers that
   *  attached before the broadcaster's bootstrap hook ran. */
  setHandler(handler: UpgradeHandler): void {
    this.handler = handler;
    const pending = this.pendingServers;
    this.pendingServers = [];
    for (const server of pending) {
      server.on("upgrade", handler);
    }
  }

  /** Wires the /v1/events upgrade handler onto `server` — immediately if
   *  the broadcaster has registered it, otherwise as soon as it does. Call
   *  once per server object; a server torn down later needs no detach
   *  (its listeners die with it). */
  attach(server: UpgradeCapableServer): void {
    if (this.handler !== null) {
      server.on("upgrade", this.handler);
      return;
    }
    this.pendingServers.push(server);
  }
}
