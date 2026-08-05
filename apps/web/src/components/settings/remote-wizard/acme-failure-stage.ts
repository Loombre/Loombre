// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/settings/remote-wizard/acme-failure-stage.ts
//
// STATE.md "Loombre Remote ..." (R5/RG12, Lane U2): the Direct/ACME step's
// "staged result display incl. failureStage guidance" (this lane's
// mission item 4). The frozen contract's RemoteDirectAcmeTestResult
// carries only `{success, detail}` — apps/server/src/remote/
// remote-direct.controller.ts's testRemoteDirectAcme returns
// `err.message` verbatim as `detail` on failure (a free-form string from
// whichever layer threw: the http-01 challenge listener's own bind error,
// or acme-client's own protocol-level error), with NO separate
// machine-readable stage field. This module is a PURE, client-side
// classifier over that free-form text — the wizard's own inference of
// "roughly where in the issuance pipeline this failed", not a contract
// change (the contract's own header explains why a bind attempt happens
// BEFORE issuance: `http01Server.listen(config.httpPort)` runs first in
// the controller, then `issueCertificate()`).
//
// Pattern sources (apps/server/src/tls/acme/http01-server.ts's `listen()`
// rejects with Node's own `net`/`http` bind error, whose `.message`
// always contains the syscall error code; apps/server/src/tls/acme/
// issue-certificate.ts's errors bubble up from acme-client, whose own
// ACME-protocol errors embed the RFC 8555 §6.7 problem-type URN verbatim,
// e.g. "urn:ietf:params:acme:error:unauthorized" / "...:rateLimited" /
// "...:dns"). Matching is case-insensitive substring search — deliberately
// coarse (never a hard parse of a shape the server doesn't contractually
// guarantee), and always falls back to "unknown" rather than mis-classify.

export type AcmeFailureStage = "portBind" | "challengeUnreachable" | "dns" | "rateLimited" | "unknown";

interface StageRule {
  stage: AcmeFailureStage;
  patterns: readonly RegExp[];
}

// Order matters: first match wins. portBind/rateLimited/dns are narrow,
// specific signals checked before the broader "unauthorized/timeout/
// connection" challengeUnreachable catch-all.
const STAGE_RULES: readonly StageRule[] = [
  { stage: "portBind", patterns: [/EADDRINUSE/i, /EACCES/i, /permission denied/i, /address already in use/i] },
  { stage: "rateLimited", patterns: [/ratelimited/i, /rate limit/i, /too many certificates/i, /too many requests/i] },
  { stage: "dns", patterns: [/acme:error:dns/i, /nxdomain/i, /no such host/i, /dns problem/i, /could not resolve/i] },
  {
    stage: "challengeUnreachable",
    patterns: [
      /acme:error:unauthorized/i,
      /acme:error:connection/i,
      /was not successful/i,
      /connection refused/i,
      /econnrefused/i,
      /connect etimedout/i,
      /timed?\s?out/i,
      /fetching http/i,
    ],
  },
];

export function classifyAcmeFailureStage(detail: string | null): AcmeFailureStage {
  if (detail === null || detail.trim().length === 0) return "unknown";
  for (const rule of STAGE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(detail))) {
      return rule.stage;
    }
  }
  return "unknown";
}

export const ACME_FAILURE_STAGE_GUIDANCE: Record<AcmeFailureStage, string> = {
  portBind:
    "Loombre couldn't open port 80 to answer the certificate challenge — something else on this machine is already using it, or the process doesn't have permission to bind a port below 1024. Free up port 80, or run Loombre with permission to bind it, then try again.",
  challengeUnreachable:
    "The certificate authority tried to reach this domain on port 80 and couldn't complete the check. Make sure your domain's DNS points at this server's public address, and that port 80 is forwarded to it — the router step below covers this.",
  dns: "This domain doesn't resolve to anything the certificate authority could reach. Check that the domain is spelled correctly and that its DNS A/AAAA record points at your server's public address.",
  rateLimited:
    "Let's Encrypt's issuance rate limit was hit for this domain. Wait before trying again — repeated attempts for the same domain in a short window are throttled on their end, not something this retry can work around immediately.",
  unknown: "The test issuance failed. Read the detail above for what the certificate authority reported, fix that, and try again.",
};
