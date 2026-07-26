// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/open-web-target.ts
//
// GET /ipc/v1/open-web-target — returns the URL; the CONTROLLER opens the
// browser (this contract never launches a browser itself, that's platform
// UI code outside this package's scope). No request body. When the server
// is not in a state that serves the web client, this is an error response
// (IpcErrorBody, code 'web-url-unavailable'), not a 200 with a null url —
// "open a URL" has no sensible degraded success case.

export type OpenWebTargetRequest = Record<string, never>;

export const OPEN_WEB_TARGET_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export interface OpenWebTargetResponse {
  url: string;
}

export const OPEN_WEB_TARGET_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1 },
  },
} as const;
