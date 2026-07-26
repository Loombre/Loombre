// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/listener.ts
//
// The loopback HTTP listener itself: a raw node:http server (mirroring the
// established in-repo pattern for a small standalone listener —
// apps/server/src/tls/acme/http01-server.ts's Http01ChallengeServer class
// — rather than mounting onto the main NestJS/Express app, since this is a
// DIFFERENT port, a DIFFERENT trust boundary [loopback-only, bearer-token,
// never LAN-exposed], and a DIFFERENT contract [packages/controller-ipc,
// not packages/contract/openapi.yaml] from the public /v1 REST API).
//
// LOOPBACK-ONLY, EXPLICITLY: binds IPC_LOOPBACK_HOST ("127.0.0.1") by name,
// never "0.0.0.0"/"::" — and, since a typo or a future refactor could
// silently widen that, start() verifies the OS's own `server.address()`
// after listen() resolves and refuses to serve at all (closes the socket,
// throws) if the bound address is not EXACTLY 127.0.0.1. See listener.spec.ts
// for the runtime proof this actually fires.
//
// Dependency-injected (IpcListenerDeps below), not built around a NestJS
// INestApplication directly — this class has no framework dependency at
// all, which is what makes "real listener on ephemeral ports" testing
// (this lane's mission deliverable 3) practical without a live Postgres or
// a fully booted Nest app; apps/server/src/ipc/index.ts is the thin Nest-
// specific adapter that supplies real deps from a running app.

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  IPC_BASE_PATH,
  IPC_LOOPBACK_HOST,
  CONTROLLER_IPC_CONTRACT_VERSION,
  type IpcStatusResponse,
  type IpcServerActionResponse,
  type OpenWebTargetResponse,
  type CrashFilesResponse,
} from "@loombre/controller-ipc";
import type { ProvisioningStatus } from "@loombre/provisioning";
import type { TlsMode } from "../tls/config.js";
import { checkAuth } from "./auth.js";
import { sendIpcError, sendJson } from "./responses.js";
import { detectStaleDiscoveryFile, removeDiscoveryFiles, writeDiscoveryFiles } from "./discovery-files.js";
import { listCrashFiles } from "./crash-dir.js";
import { computeWorkerProcessInfo, type RecentJobSignal } from "./worker-liveness.js";
import { resolveWebUrl } from "./web-url.js";

export interface IpcListenerDeps {
  env: NodeJS.ProcessEnv;
  /** Base directory for discovery/token files + the crash-files listing —
   *  resolveAppPaths(process.platform, env).dataDir, same seam
   *  apps/server/src/bootstrap/provisioning.ts already uses. */
  dataDir: string;
  /** The MAIN server's own already-bound HTTP(S) port (NOT this listener's
   *  own ephemeral port) — used only for the webUrl fallback. */
  serverPort: number;
  serverTlsMode: TlsMode;
  version: string;
  getProvisioningStatus: () => ProvisioningStatus;
  listRecentJobs: () => Promise<RecentJobSignal[]>;
  /** Test seams; default to the real process's own pid/start time. */
  serverPid?: number;
  serverStartedAtMs?: number;
  /** The actual side effect POST /server/stop triggers once its 200 has
   *  flushed — defaults to the real, orchestrator-sanctioned self-signal
   *  (`process.kill(process.pid, "SIGTERM")`, see decision (a)/handleServerStop's
   *  own comment). Overridable ONLY so tests can prove this fires without
   *  actually terminating the test process itself — production callers
   *  (ipc/index.ts) never override it. */
  sendStopSignal?: () => void;
}

export interface IpcListenerHandle {
  port: number;
  token: string;
  stop(): Promise<void>;
}

export class IpcListener {
  private server: http.Server | null = null;
  private token: string | null = null;
  private serverPid: number | null = null;
  private serverStartedAtMs: number | null = null;
  /** Bound reference to THIS instance's 'exit' cleanup handler, tracked so
   *  stop() can remove it again — matters for tests (many short-lived
   *  IpcListener instances per process, via start()/stop() cycles) and for
   *  correctness in general: an instance that has already been gracefully
   *  stop()'d should not still fire cleanup work (harmless here, since
   *  removeDiscoveryFiles is idempotent, but leaving a dead instance's
   *  listener registered forever is still a real leak — Node warns past 10
   *  listeners on the same event for exactly this reason). */
  private exitHandler: (() => void) | null = null;

  constructor(private readonly deps: IpcListenerDeps) {}

  async start(): Promise<IpcListenerHandle> {
    const stale = detectStaleDiscoveryFile(this.deps.dataDir);
    if (stale.found) {
      console.log(
        stale.stale
          ? `ipc: found a stale discovery file from a previous boot (pid ${stale.pid ?? "unknown"} is not running) — overwriting.`
          : `ipc: found a discovery file whose pid (${stale.pid ?? "unknown"}) still appears to be alive — overwriting anyway (only one IPC listener is ever expected per data dir; if that pid is a genuinely different live server instance, this is likely a misconfiguration).`,
      );
    }

    const server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, IPC_LOOPBACK_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("ipc: unreachable — TCP server.address() returned no AddressInfo after listen()");
    }
    // Belt-and-suspenders proof that this is loopback-only: bind used the
    // literal IPC_LOOPBACK_HOST string above, but this asserts the OS
    // actually honored it rather than trusting the call site forever.
    if (address.address !== IPC_LOOPBACK_HOST) {
      server.close();
      throw new Error(
        `ipc: refusing to serve — bound address is "${address.address}", expected exactly "${IPC_LOOPBACK_HOST}". This must never be reachable off-loopback.`,
      );
    }

    this.server = server;
    this.serverPid = this.deps.serverPid ?? process.pid;
    this.serverStartedAtMs = this.deps.serverStartedAtMs ?? Math.round(Date.now() - process.uptime() * 1000);

    const written = writeDiscoveryFiles(
      this.deps.dataDir,
      { port: address.port, pid: this.serverPid, startedAtMs: this.serverStartedAtMs },
      this.deps.env,
    );
    this.token = written.token;

    // Synchronous cleanup on ANY process exit path (SIGTERM handler
    // elsewhere calling process.exit(), an uncaught exception, a normal
    // return from main) — same established pattern as apps/server/src/
    // bootstrap/provisioning.ts's own `process.once("exit", () =>
    // instance.killSync())`. 'exit' listeners must be synchronous;
    // removeDiscoveryFiles is. Tracked on `this` (not fire-and-forget) so
    // stop() can remove it again — see the field's own doc comment.
    this.exitHandler = () => removeDiscoveryFiles(this.deps.dataDir);
    process.once("exit", this.exitHandler);

    console.log(`ipc: listening on ${IPC_LOOPBACK_HOST}:${address.port} (loopback-only, data dir ${this.deps.dataDir})`);

    return { port: address.port, token: this.token, stop: () => this.stop() };
  }

  async stop(): Promise<void> {
    removeDiscoveryFiles(this.deps.dataDir);
    if (this.exitHandler !== null) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
    const server = this.server;
    this.server = null;
    this.token = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** The actual OS-reported bound address, once start() has resolved —
   *  exposed so tests can assert loopback-only directly against reality
   *  rather than trusting this class's own internal check. Always exactly
   *  IPC_LOOPBACK_HOST in practice: start() throws (and closes the socket)
   *  if the OS ever hands back anything else. */
  get boundAddress(): string | undefined {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== "string" ? address.address : undefined;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    void this.handleRequestAsync(req, res).catch((err: unknown) => {
      console.error("ipc: unhandled error handling request:", err);
      if (!res.headersSent) {
        sendIpcError(res, 500, "internal-error", "Internal error.");
      } else {
        res.destroy();
      }
    });
  }

  private async handleRequestAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.token === null) {
      sendIpcError(res, 500, "internal-error", "IPC listener is not fully initialized yet.");
      return;
    }

    // Every request authenticates — transport.ts: "Convention every
    // request ... authenticates with Authorization: Bearer <token>". The
    // token itself is never logged, on success or failure — only the fact
    // of a failure.
    if (!checkAuth(req.headers, this.token)) {
      sendIpcError(res, 401, "unauthorized", "Missing or invalid Authorization header.");
      return;
    }

    const { pathname } = new URL(req.url ?? "/", "http://ipc.invalid");
    const method = req.method ?? "GET";
    const base = IPC_BASE_PATH;

    if (method === "GET" && pathname === `${base}/status`) return this.handleStatus(res);
    if (method === "POST" && pathname === `${base}/server/start`) return this.handleServerStart(res);
    if (method === "POST" && pathname === `${base}/server/stop`) return this.handleServerStop(res);
    if (method === "GET" && pathname === `${base}/open-web-target`) return this.handleOpenWebTarget(res);
    if (method === "GET" && pathname === `${base}/crash-files`) return this.handleCrashFiles(res);

    // No route matched. IPC_ERROR_CODES (error-body.ts, FROZEN) has no
    // dedicated "not-found" member — 'internal-error' is the closest
    // available closed-enum value. Flagged in this lane's report as a
    // candidate additive contract enhancement (a real not-found code),
    // matching how this repo already tracks similar closed-enum gaps
    // (STATE.md's "candidate additive contract enrichments" entries).
    sendIpcError(res, 404, "internal-error", "Unknown IPC operation.", `${method} ${pathname}`);
  }

  private async handleStatus(res: ServerResponse): Promise<void> {
    const jobs = await this.deps.listRecentJobs().catch((err: unknown) => {
      console.error("ipc: listRecentJobs failed while building /status — reporting worker as stopped:", err);
      return [] as RecentJobSignal[];
    });

    const body: IpcStatusResponse = {
      ipcContractVersion: CONTROLLER_IPC_CONTRACT_VERSION,
      server: {
        // Reachable at all => this process (the server) is up. See the
        // transport.ts IPC_SERVER_START_SEMANTICS amendment: the listener
        // lives inside the server process, so no other value is ever
        // observable from in here.
        state: "running",
        pid: this.serverPid,
        startedAtMs: this.serverStartedAtMs,
        version: this.deps.version,
      },
      worker: computeWorkerProcessInfo(jobs, this.deps.version),
      webUrl: resolveWebUrl(this.deps.env, this.deps.serverPort, this.deps.serverTlsMode),
      provisioning: this.deps.getProvisioningStatus(),
    };
    sendJson(res, 200, body);
  }

  private handleServerStart(res: ServerResponse): void {
    // Decision (a): always 409. See transport.ts's IPC_SERVER_START_SEMANTICS
    // amendment for the full rationale + the platform-specific "how to
    // actually start a stopped server" guidance this detail string
    // summarizes.
    sendIpcError(
      res,
      409,
      "server-already-running",
      "The Loombre server is already running.",
      "POST /ipc/v1/server/start is served by the server process itself, so reaching it at all proves the server is already up (packages/controller-ipc's IPC_SERVER_START_SEMANTICS). To start a STOPPED server, use your platform's service manager (Windows service, launchd, or systemd).",
    );
  }

  private handleServerStop(res: ServerResponse): void {
    const body: IpcServerActionResponse = { accepted: true, state: "stopping" };
    sendJson(res, 200, body);
    // Send the signal only once the response has actually been flushed to
    // the socket — the client must see this 200 before the process starts
    // tearing itself down. process.kill(process.pid, "SIGTERM") is the
    // orchestrator-sanctioned self-signal (coordinates with G1's own
    // SIGTERM handling work in main.ts; see STATE.md's Windows SIGBREAK
    // gap note for the one known platform caveat this doesn't attempt to
    // fix here).
    const sendStopSignal =
      this.deps.sendStopSignal ??
      (() => {
        process.kill(process.pid, "SIGTERM");
      });
    res.once("finish", () => {
      console.log(`ipc: server/stop requested over IPC — sending SIGTERM to self (pid ${process.pid})`);
      sendStopSignal();
    });
  }

  private handleOpenWebTarget(res: ServerResponse): void {
    const url = resolveWebUrl(this.deps.env, this.deps.serverPort, this.deps.serverTlsMode);
    // resolveWebUrl always returns a non-empty string today (LOOMBRE_WEB_URL
    // override or a computed origin) — this branch is unreachable given the
    // current implementation, kept for contract completeness / forward
    // compatibility with a future server state that genuinely has no web
    // target (see web-url.ts's own header for the open architecture
    // question this depends on).
    if (url.length === 0) {
      sendIpcError(res, 409, "web-url-unavailable", "No web URL is available right now.");
      return;
    }
    const body: OpenWebTargetResponse = { url };
    sendJson(res, 200, body);
  }

  private handleCrashFiles(res: ServerResponse): void {
    const body: CrashFilesResponse = { files: listCrashFiles(this.deps.dataDir) };
    sendJson(res, 200, body);
  }
}
