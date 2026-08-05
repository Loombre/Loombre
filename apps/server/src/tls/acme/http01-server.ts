// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/http01-server.ts
//
// The HTTP-01 challenge listener (P4.4's ":80 challenge listener"). Binds
// LOOMBRE_HTTP_PORT — 80 by default, 36xx in every test — on 0.0.0.0
// deliberately: HTTP-01 validation is the CA connecting to Loombre from the
// public internet (or, in the pebble integration test, from the pebble
// container across the docker network), so loopback-only would make the
// challenge unreachable by construction. This is inherent to the HTTP-01
// challenge type, not a Loombre choice to relax — docs/ops/remote-access/acme.md says so.
//
// Serves exactly two things:
//   - GET /.well-known/acme-challenge/<token> -> the registered key
//     authorization for that token (200), or 404 if unknown/removed.
//   - everything else -> a 301 redirect to the same path on
//     LOOMBRE_HTTPS_PORT when one is configured, else 404. A plain HTTP
//     port that ONLY serves challenges and otherwise silently 404s would
//     be a confusing dead end for anyone who types the bare domain into a
//     browser — the redirect is the standard "port 80 exists so ACME
//     works, but real traffic always ends up on 443" shape.

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const WELL_KNOWN_PREFIX = "/.well-known/acme-challenge/";

export interface Http01ServerOptions {
  /** Bind host. Defaults to 0.0.0.0 — see module doc for why this can't
   *  default to loopback. Tests that don't need real network reachability
   *  (unit-level, same-process request) may still override to 127.0.0.1. */
  host?: string;
  /** When set, any request outside the well-known challenge path 301s to
   *  this port on HTTPS instead of 404ing. */
  redirectHttpsPort?: number;
}

export class Http01ChallengeServer {
  private readonly tokens = new Map<string, string>();
  private server: http.Server | null = null;

  constructor(private readonly opts: Http01ServerOptions = {}) {}

  register(token: string, keyAuthorization: string): void {
    this.tokens.set(token, keyAuthorization);
  }

  unregister(token: string): void {
    this.tokens.delete(token);
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once("error", reject);
      server.listen(port, this.opts.host ?? "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
      this.server = server;
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** The bound port, once listen() has resolved — mainly for tests that
   *  listen(0) (ephemeral port) and need to know what they got. */
  get port(): number | undefined {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? address.port : undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0] ?? "/";

    if (req.method === "GET" && path.startsWith(WELL_KNOWN_PREFIX)) {
      const token = decodeURIComponent(path.slice(WELL_KNOWN_PREFIX.length));
      const keyAuthorization = this.tokens.get(token);
      if (keyAuthorization !== undefined) {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(keyAuthorization) });
        res.end(keyAuthorization);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    if (this.opts.redirectHttpsPort !== undefined) {
      const hostHeader = req.headers.host ?? "";
      const hostname = hostHeader.split(":")[0];
      res.writeHead(301, { Location: `https://${hostname}:${this.opts.redirectHttpsPort}${rawUrl}` });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}
