// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/brand/boot-log.ts
//
// STATE.md "Blaze logo rollout" D6/G5 — the boot splash's log lines MUST
// derive from real client boot state; the reference (design/blaze/assets/
// loombre-splash.html:34-36) hardcodes three placeholder lines — a
// core-version line, a media mount-path line, and a stream-readiness line.
// (Their exact strings are deliberately NOT quoted here: the
// brand:fixture-strings gate bans them from apps/ source, this comment
// included — see the reference file itself, and the one allowlisted guard,
// BootSplash.fixtures.test.tsx.)
//
// All three are placeholder fixtures. G5's kickoff recon already ruled out
// two of them outright: there is no server-discovery/mount-path concept
// reachable pre-auth (GET /libraries is authed) and no engine-readiness
// contract field exists anywhere — inventing "OK"/"READY" values for either
// would be exactly the kind of fabricated-fixture the U9 ledger convention
// (app/login/page.tsx:12-45) exists to prevent. This module derives THREE
// real substitutes instead, reusing sources this app already has:
//
//   1. CLIENT  -> APP_VERSION (lib/app-version.ts) — the one version string
//      every audience (authed or not) can reach, per G5's own finding.
//   2. SERVER  -> describeServerUrl()'s host[:port] + TLS-ness — the exact
//      login-page precedent (server-url.ts's own header): a URL genuinely
//      tells you a host and a scheme, nothing more, so that's all this
//      shows. No name, no fabricated latency.
//   3. SESSION -> whether a persisted device/refresh chain already exists
//      locally (AuthStore.isAuthenticated()) — a real, synchronous,
//      no-network fact about THIS browser, not a probe of the server.
//
// Exact label/value copy below is a Lane B freeze-report PROPOSAL for
// orchestrator adjudication (STATE.md G5 says so explicitly) — treat this
// as a first draft, not a locked contract.

import { APP_VERSION } from "../../lib/app-version.js";
import { describeServerUrl } from "../../lib/server-url.js";

export interface BootLogLine {
  label: string;
  value: string;
}

export interface BootLogInput {
  /** The server URL the client would connect to — same source the login
   *  page already resolves (persisted store value, falling back to the
   *  same-origin guess). May be empty (nothing set yet). */
  serverUrl: string;
  /** AuthStore.isAuthenticated() at splash-mount time: a persisted
   *  refresh/device chain exists in this browser. This does NOT mean the
   *  token is still valid server-side (unknowable pre-auth) — it only
   *  reports the real local fact "there is a session to try". */
  hasStoredSession: boolean;
}

/** Three lines, matching the reference's row count and stagger (1.0s /
 *  1.35s / 1.7s, wired in BootSplash.module.css) — content only, no
 *  fixtures. */
export function getBootLogLines({ serverUrl, hasStoredSession }: BootLogInput): BootLogLine[] {
  const server = describeServerUrl(serverUrl);
  return [
    { label: "LOOMBRE CLIENT", value: `V${APP_VERSION}` },
    {
      label: "SERVER",
      value: server ? `${server.host}${server.tls ? " · TLS" : ""}` : "NOT SET",
    },
    { label: "SESSION", value: hasStoredSession ? "RESTORED" : "NEW" },
  ];
}
