// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/responses.ts
//
// Small JSON response helpers shared by every handler — keeps
// Content-Type/status-code plumbing in one place and, more importantly,
// keeps every non-2xx response shaped exactly like error-body.ts's
// IpcErrorBody, since that shape is part of the frozen contract every
// client (Windows/macOS) already parses.

import type { ServerResponse } from "node:http";
import type { IpcErrorCode } from "@loombre/controller-ipc";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendIpcError(res: ServerResponse, status: number, code: IpcErrorCode, title: string, detail?: string): void {
  sendJson(res, status, detail !== undefined ? { title, status, code, detail } : { title, status, code });
}
