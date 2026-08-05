// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/connector-health.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 connectorHealth, S1 lane). Pure
// grading function over the Tunnel path's supervised cloudflared child
// process state (RG7); the impure "read the connector's live state" half
// is ../connector-health.reader.ts's ConnectorHealthReaderService (a
// narrow seam — T2 wires the real supervisor's health read here at
// integration; see that file's header).
//
// `unknown` defaults to `warn` (per the mission brief, verbatim): an
// unreadable connector state is itself worth a caution, not a silent
// pass — same "absence of information is not evidence of health" posture
// wgPortSilence's `warn` branch takes.
//
// FALSE-GREEN HUNT: this check only ever reports what the CONNECTOR
// SUPERVISOR believes its own child process's state to be — it cannot
// verify that Cloudflare's edge actually considers the tunnel healthy
// (that would require an outbound call to Cloudflare's own API, which is
// out of scope for a posture check that must stay cheap/synchronous), nor
// that DNS for the tunnel hostname currently resolves to it. "running"
// here means "the supervised process is alive and hasn't reported an
// error", not "traffic is provably flowing end-to-end" — that stronger
// claim belongs to R6's reachability proof, not this card.

import type { PostureCheckOutcome } from "./types.js";

export type ConnectorHealthState = "unknown" | "stopped" | "starting" | "running" | "degraded" | "error";

export function gradeConnectorHealth(state: ConnectorHealthState): PostureCheckOutcome {
  switch (state) {
    case "unknown":
      return { grade: "warn", detail: "The tunnel connector's health could not be read." };
    case "running":
      return { grade: "pass", detail: "The tunnel connector is running normally." };
    case "starting":
      return { grade: "info", detail: "The tunnel connector is still starting." };
    case "degraded":
      return { grade: "warn", detail: "The tunnel connector is degraded — recent failures or restarts." };
    case "stopped":
      return { grade: "fail", detail: "The Tunnel path is enabled but its connector is stopped." };
    case "error":
      return { grade: "fail", detail: "The tunnel connector reported an error." };
  }
}
