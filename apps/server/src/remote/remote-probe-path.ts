// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-probe-path.ts
//
// Shared runtime validation for the `path` field both createRemoteProbe
// (remote-probes.controller.ts) and diagnoseRemote
// (remote-diagnosis.controller.ts) require (P1 adjudication — see
// packages/contract/openapi.yaml's CreateRemoteProbeRequest/
// DiagnoseRemoteRequest descriptions). A dedicated file rather than one
// controller importing from another's module.

import type { RemoteProbePath } from "@loombre/db";

export const REMOTE_PROBE_PATHS: ReadonlySet<RemoteProbePath> = new Set<RemoteProbePath>(["remote", "tunnel", "direct"]);

export function isRemoteProbePath(value: unknown): value is RemoteProbePath {
  return typeof value === "string" && (REMOTE_PROBE_PATHS as ReadonlySet<string>).has(value);
}
