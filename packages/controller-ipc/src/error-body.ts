// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/error-body.ts
//
// A small RFC-9457-SHAPED (title/status/detail) error body for this
// contract's non-2xx responses — deliberately NOT an import of
// packages/contract's Problem schema. This package's brief allows exactly
// one cross-package import (ProvisioningStatus, see status.ts) and this is
// loopback tooling, not the public /v1 REST contract, so it gets its own
// small closed `code` enum rather than reaching into the public contract
// package for a shape that happens to look similar.

export type IpcErrorCode =
  | "unauthorized"
  | "server-already-running"
  | "server-not-running"
  | "web-url-unavailable"
  | "internal-error";

export const IPC_ERROR_CODES = [
  "unauthorized",
  "server-already-running",
  "server-not-running",
  "web-url-unavailable",
  "internal-error",
] as const;

export interface IpcErrorBody {
  title: string;
  status: number;
  code: IpcErrorCode;
  detail?: string;
}

export const IPC_ERROR_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "status", "code"],
  properties: {
    title: { type: "string", minLength: 1 },
    status: { type: "integer", minimum: 100, maximum: 599 },
    code: { type: "string", enum: [...IPC_ERROR_CODES] },
    detail: { type: "string" },
  },
} as const;
