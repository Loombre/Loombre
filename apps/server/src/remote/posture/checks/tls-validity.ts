// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/tls-validity.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 tlsValidity, S1 lane). Pure
// grading function — no I/O, no framework: the impure "read the actual
// certificate" half lives in ../remote-posture.service.ts (apps/server/src/
// tls/config.ts's TlsConfig + apps/server/src/tls/acme/cert-store.ts's
// loadPersistedCertificate / apps/server/src/tls/manual-provider.ts's
// readManualCertificate, both parsed via acme-client's generic
// readCertificateInfo — see that service's own header for why those are
// the RIGHT "existing tls cert-store" per the mission brief).
//
// FALSE-GREEN HUNT (what this check cannot see): it only ever grades the
// Direct path's OWN mode (manual/acme). When LOOMBRE_TLS_MODE is "off"
// (the honest state for Direct's mode:"reverse-proxy" — TLS terminates
// somewhere Loombre never sees, e.g. an operator's nginx/Caddy in front of
// it) there is no certificate for this process to read at all — grading
// that "pass" would be a flat lie (S1 has no idea whether the real
// terminator's cert is even valid), so it degrades to `info` instead:
// "Loombre isn't the one holding a certificate here; check separately."
// This is exactly the blind spot V-SEC should probe for on this check.

import type { PostureCheckOutcome } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_TLS_WARN_WINDOW_DAYS = 14;

export interface TlsValidityInput {
  mode: "off" | "manual" | "acme";
  /** The parsed certificate's expiry, when one could be read. Meaningless
   *  (ignored) when mode is "off"; undefined for "manual"/"acme" means a
   *  real read/parse attempt FAILED — a genuine problem, not a blind spot. */
  cert: { notAfterMs: number } | undefined;
  nowMs: number;
  /** Days before expiry the grade drops to `warn`. Defaults to 14 — half
   *  of tls/renewal.ts's own 30-day DEFAULT_RENEW_WINDOW_DAYS, deliberately
   *  tighter: renewal is expected to have already happened by day 30, so a
   *  posture warning should not fire at the exact same instant the
   *  ordinary renewal machinery is expected to have already handled it —
   *  it should fire only if that machinery looks like it might be running
   *  late. */
  warnWindowDays?: number;
}

export function gradeTlsValidity(input: TlsValidityInput): PostureCheckOutcome {
  if (input.mode === "off") {
    return {
      grade: "info",
      detail:
        "Loombre is not terminating TLS itself for the Direct path (e.g. a reverse proxy handles it) — it cannot verify a certificate it never sees. Check the terminator's certificate separately.",
    };
  }

  if (input.cert === undefined) {
    return {
      grade: "fail",
      detail: `No TLS certificate could be read for the Direct path (mode=${input.mode}) — the Direct path is enabled but Loombre currently has no usable certificate.`,
    };
  }

  const daysLeft = Math.floor((input.cert.notAfterMs - input.nowMs) / MS_PER_DAY);
  if (input.cert.notAfterMs <= input.nowMs) {
    return {
      grade: "fail",
      detail: `The TLS certificate expired ${Math.abs(daysLeft)} day(s) ago.`,
    };
  }

  const warnWindowDays = input.warnWindowDays ?? DEFAULT_TLS_WARN_WINDOW_DAYS;
  if (daysLeft <= warnWindowDays) {
    return {
      grade: "warn",
      detail: `The TLS certificate expires in ${daysLeft} day(s).`,
    };
  }

  return {
    grade: "pass",
    detail: `The TLS certificate is valid for ${daysLeft} more day(s).`,
  };
}
