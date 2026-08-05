// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/cloudflared-log-signals.ts
//
// STATE.md RG7 (T2): tolerant classification of cloudflared's own
// stdout/stderr lines — ground-truthed against cloudflared's real log text
// (this lane's report cites: GitHub cloudflare/cloudflared issue titles
// "Cloudflare Tunnel connection dropping with Unregistered tunnel
// connection" (#735) and community/Cloudflare-docs discussion of "Many
// http/2 tunnels ... getting repeatedly disconnected Connection terminated
// error=..." confirm the exact phrases below; Cloudflare's own tunnel
// status model — developers.cloudflare.com troubleshoot-tunnels/common-errors
// — names "Healthy" (four connections registered), "Degraded" (running,
// at least one connection failed), and "Down" (process stopped) as the
// states these lines distinguish).
//
// A successful connection registration logs a line containing the phrase
// "Registered tunnel connection" (e.g. "Registered tunnel connection
// connIndex=0 connection=<uuid> event=0 ip=<edge-ip> location=<PoP>
// protocol=quic"). A lost-but-not-crashed connection logs "Unregistered
// tunnel connection", and cloudflared's own internal reconnect logic
// additionally logs phrases like "Retrying connection"/"Connection
// terminated" while the PROCESS itself stays alive — cloudflared manages
// up to four independent connections to the edge and reconnects individual
// ones without the process ever exiting, so these lines are this module's
// "unhealthy" signal (alive, degraded), distinct from a process CRASH
// (driven by the child's own exit event, not by any log line — see
// cloudflared-connector-manager.ts).
//
// Deliberately tolerant, not a strict structured-log parser: cloudflared's
// log format (key=value pairs after the message, occasionally full JSON in
// some configurations) has varied across versions, and this module only
// ever needs the fixed English message text — matched case-insensitively
// on a WORD boundary so "Unregistered..." (which contains the substring
// "registered") can never false-positive as a readiness signal.
//
// "failed to sufficiently increase receive buffer size" (a quic-go UDP
// buffer-size warning; Cloudflare's own docs describe it as "generally not
// impactful and can be safely ignored") is deliberately NOT matched by
// anything here — every unrecognized line is a no-op for the state
// machine, which is the correct behavior for log noise this module
// doesn't know about.

const READY_RE = /\bregistered tunnel connection\b/i;
const CONNECTION_LOST_RE = /\bunregistered tunnel connection\b|\bretrying connection\b|\bconnection terminated\b/i;

export type CloudflaredLogSignal = "ready" | "connection-lost" | null;

/** Classifies ONE already-newline-split line. Never throws. */
export function classifyCloudflaredLogLine(line: string): CloudflaredLogSignal {
  if (READY_RE.test(line)) return "ready";
  if (CONNECTION_LOST_RE.test(line)) return "connection-lost";
  return null;
}
