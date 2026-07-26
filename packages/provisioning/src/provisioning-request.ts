// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/provisioning-request.ts
//
// The request half of the ProvisioningInterface seam (docs/PLAN.md §11,
// STATE.md P4.2/P4.7): what an installer lane (I1-I4) hands the
// embedded-PG lane (B) to bring a local PostgreSQL instance up.
// Platform-correct app-data base directory resolution is explicitly the
// CALLER's concern (XDG / %ProgramData% / ~/Library/Application Support
// per docs/PLAN.md §11) — this interface only ever sees the already
// -resolved absolute path, never resolves one itself (no I/O in this
// package at all).

import { ABSOLUTE_PATH_PATTERN } from "./absolute-path.js";
import { SECRET_REF_SCHEMA, type SecretRef } from "./secret-ref.js";
import { LISTEN_STRATEGY_SCHEMA, type ListenStrategy } from "./listen-strategy.js";

/** Postgres full-version string, e.g. "17.4" (major.minor[.patch]). */
export const PG_FULL_VERSION_PATTERN = "^[0-9]+\\.[0-9]+(\\.[0-9]+)?$";

/**
 * D1: "PostgreSQL 17 only" is today's pin — the floor below mirrors that
 * decision literally. When the pin moves to a newer major this is a
 * deliberate, coordinated contract edit (same discipline as any other
 * closed-enum change in this repo), not a silent drift.
 */
export const PROVISIONING_REQUEST_MIN_PG_MAJOR = 17;

export interface ProvisioningRequest {
  /** Pinned PostgreSQL major version (D1). */
  pgMajor: number;
  /** Pinned full PostgreSQL version string, e.g. "17.4". */
  pgFullVersion: string;
  /** Absolute path to the data directory. App-data base resolution is the caller's concern. */
  dataDir: string;
  listenStrategy: ListenStrategy;
  /** initdb locale, e.g. "en_US.UTF-8". */
  locale: string;
  /** initdb encoding. Closed to UTF8 — Loombre never provisions a non-UTF8 cluster. */
  encoding: "UTF8";
  /** P4.7 seam: never a plaintext credential. */
  superuserSecretRef: SecretRef;
}

export const PROVISIONING_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "pgMajor",
    "pgFullVersion",
    "dataDir",
    "listenStrategy",
    "locale",
    "encoding",
    "superuserSecretRef",
  ],
  properties: {
    pgMajor: { type: "integer", minimum: PROVISIONING_REQUEST_MIN_PG_MAJOR },
    pgFullVersion: { type: "string", pattern: PG_FULL_VERSION_PATTERN },
    dataDir: { type: "string", minLength: 1, pattern: ABSOLUTE_PATH_PATTERN },
    listenStrategy: LISTEN_STRATEGY_SCHEMA,
    locale: { type: "string", minLength: 1 },
    encoding: { const: "UTF8" },
    superuserSecretRef: SECRET_REF_SCHEMA,
  },
} as const;
