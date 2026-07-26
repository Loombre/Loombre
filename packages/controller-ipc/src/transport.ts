// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/transport.ts
//
// v1 transport: loopback-only local HTTP. This is NOT part of the public
// /v1 REST contract (packages/contract/openapi.yaml) and must never be
// exposed on the LAN — the server binds strictly to 127.0.0.1 on an
// ephemeral port, writes that port to a well-known file under the app-data
// dir, and writes a bearer token to a 0600 file alongside it. A controller
// app discovers both by reading those two files, never by scanning ports
// or guessing.
//
// Transport upgrade path (documented, not built here): a future version
// may move to Windows named pipes / Unix domain sockets for a slightly
// tighter local-only guarantee than "bind to 127.0.0.1" gives (no
// same-host-different-user TCP access on multi-user boxes). That is an
// additive transport change behind the same request/response shapes in
// this package — CONTROLLER_IPC_CONTRACT_VERSION exists precisely so a
// controller can tell whether the server it's talking to has made that
// jump.
//
// See the bottom of this file for the Phase 4 Wave 2 AMENDMENT section
// (IPC_SERVER_START_SEMANTICS) — the one orchestrator-sanctioned, purely
// additive edit to this otherwise-FROZEN package.

/** Mount path for every operation in this contract. Carries the coarse
 *  "v1" — CONTROLLER_IPC_CONTRACT_VERSION (contract-version.ts) is the
 *  fine-grained number for additive changes within it. */
export const IPC_BASE_PATH = "/ipc/v1";

/** Loopback host the v1 HTTP transport binds to. Never 0.0.0.0 / ::. */
export const IPC_LOOPBACK_HOST = "127.0.0.1";

/** Filename (under the platform app-data dir, alongside the data dir
 *  itself — resolving that base path is the CALLER's concern, same as
 *  @loombre/provisioning's dataDir) holding the ephemeral port + discovery
 *  metadata as JSON. World-readable is fine — a port number is not a
 *  secret. */
export const IPC_DISCOVERY_FILENAME = "controller-ipc.json";

/** Filename alongside IPC_DISCOVERY_FILENAME holding the bearer token as
 *  raw UTF-8 text (no JSON wrapper, no trailing newline required). MUST be
 *  created 0600 (owner-read/write only) — this is the actual secret. */
export const IPC_TOKEN_FILENAME = "controller-ipc.token";

/** Convention every request (except discovery-file reads, which are local
 *  filesystem, not HTTP) authenticates with:
 *  `Authorization: Bearer <token from IPC_TOKEN_FILENAME>`. */
export const IPC_AUTH_HEADER = "authorization";
export const IPC_AUTH_SCHEME = "Bearer";

export interface IpcDiscoveryFile {
  /** Ephemeral TCP port the server bound on IPC_LOOPBACK_HOST. */
  port: number;
  /** Always IPC_LOOPBACK_HOST in v1 — carried explicitly (not assumed) so
   *  a v2 transport upgrade can add other values additively. */
  host: "127.0.0.1";
  /** PID of the server process that wrote this file, so a controller can
   *  tell a stale file (process no longer running) from a live one. */
  pid: number;
  startedAtMs: number;
}

export const IPC_DISCOVERY_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["port", "host", "pid", "startedAtMs"],
  properties: {
    port: { type: "integer", minimum: 1, maximum: 65535 },
    host: { const: "127.0.0.1" },
    pid: { type: "integer", minimum: 1 },
    startedAtMs: { type: "integer", minimum: 0 },
  },
} as const;

// ============================================================================
// AMENDMENT — Phase 4 Wave 2, IPC-listener lane (2026-07-24). Orchestrator-
// sanctioned; this is the ONE permitted edit to this otherwise-FROZEN
// package (docs + one new additive export below). No existing export is
// changed, removed, or retyped; CONTROLLER_IPC_CONTRACT_VERSION stays at 1
// (VERSION NOTE: nothing here is a wire-format change — a controller that
// only ever reads IpcServerActionResponse/IpcErrorBody needs zero code
// changes to keep working after this amendment lands).
// ============================================================================
//
// STARTSEMANTICS — where POST /ipc/v1/server/start's authority actually
// lives. The server-side implementation of this whole contract
// (apps/server/src/ipc/**, Phase 4 Wave 2) lives INSIDE the server process
// itself — there is no separate always-on "controller daemon" hosting this
// listener. A direct, load-bearing consequence for every controller author:
//
//   POST /ipc/v1/server/start is only ever REACHABLE over HTTP while the
//   server process — and therefore this very listener — is already up.
//   There is no live listener to answer the request while the server is
//   stopped, so in v1 this endpoint deterministically responds 409 with
//   IpcErrorBody.code === "server-already-running" every single time it is
//   successfully reached at all.
//
// This is not a bug and not a placeholder pending a "real" implementation —
// it is the documented shape of v1. A controller that wants to start a
// STOPPED server must go around this contract entirely and use the
// platform's own service manager, exactly as it already must for anything
// else that needs to run before any Loombre process exists to answer HTTP:
export interface IpcServerStartSemantics {
  /** Always true in v1 — see the amendment note above. */
  readonly reachableOnlyWhenRunning: true;
  /** The error-body.ts IpcErrorCode POST /server/start always returns, given
   *  the above — never any other member of IPC_ERROR_CODES. */
  readonly alwaysReturnsErrorCode: "server-already-running";
  /** Real, already-shipped (Phase 4 Wave 1) mechanisms for starting a
   *  STOPPED server on each platform — not a future promise. */
  readonly startAStoppedServerVia: {
    readonly windows: string;
    readonly macos: string;
    readonly linux: string;
  };
}

export const IPC_SERVER_START_SEMANTICS: IpcServerStartSemantics = {
  reachableOnlyWhenRunning: true,
  alwaysReturnsErrorCode: "server-already-running",
  startAStoppedServerVia: {
    windows:
      "the Windows service manager (`sc start LoombreServer`, or the Services snap-in) — installers/windows/msi's Services.wxs registers this service name.",
    macos:
      "launchctl (`launchctl bootstrap system /Library/LaunchDaemons/com.loombre.server.plist`) — installers/macos/pkg/launchd's LaunchDaemon.",
    linux:
      "systemd (`systemctl start loombre-server`) — installers/linux's tarball-bundled unit file.",
  },
} as const;
