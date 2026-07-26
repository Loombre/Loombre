// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/listen-strategy.ts
//
// How the embedded PostgreSQL instance is reachable — ALWAYS localhost-only
// (P4.2: "child process on localhost socket"; embedded PG is never a LAN
// service, remote access to Loombre itself goes through the app server, not
// the database). Modeled as a discriminated union rather than one shape
// with an optional `port`: Unix domain sockets aren't the natural (or
// always available) choice on every platform the installer lanes target,
// and a discriminated union makes "a port on the socket variant" a type
// error instead of a runtime validation concern.

export type ListenStrategy =
  | { kind: "unix-socket"; socketDir: string }
  | { kind: "tcp-loopback"; port: number };

export const LISTEN_STRATEGY_KINDS = ["unix-socket", "tcp-loopback"] as const;

/**
 * Accepted TCP port range for the loopback strategy. Floor of 1024 keeps
 * provisioning out of privileged-port territory on every platform (no
 * elevated-process requirement); ceiling is the standard TCP port max.
 */
export const LISTEN_STRATEGY_TCP_PORT_MIN = 1024;
export const LISTEN_STRATEGY_TCP_PORT_MAX = 65535;

export const LISTEN_STRATEGY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "socketDir"],
      properties: {
        kind: { const: "unix-socket" },
        socketDir: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "port"],
      properties: {
        kind: { const: "tcp-loopback" },
        port: {
          type: "integer",
          minimum: LISTEN_STRATEGY_TCP_PORT_MIN,
          maximum: LISTEN_STRATEGY_TCP_PORT_MAX,
        },
      },
    },
  ],
} as const;
