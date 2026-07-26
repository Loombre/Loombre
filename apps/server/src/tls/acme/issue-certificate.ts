// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/issue-certificate.ts
//
// The real account/order/challenge/finalize flow (P4.4), via acme-client's
// `Client#auto()` — the library's own supported "handle account creation,
// order placement, challenge selection, finalization, and download" path,
// with Loombre supplying exactly the two seams the library asks for:
// challengeCreateFn/challengeRemoveFn. Nothing about the ACME protocol
// itself is reimplemented here; this file's job is wiring those two
// callbacks to http01-server.ts / dns01-hook.ts and shaping the result.
//
// A note on DNS-01 and the TXT record value: acme-client's own
// `getChallengeKeyAuthorization()` ALREADY returns the RFC 8555 §8.4
// digest (base64url(SHA256(keyAuthorization))) when `challenge.type ===
// 'dns-01'` — confirmed by reading src/client.js, not assumed from the
// http-01 shape. The `keyAuthorization` argument this module's
// challengeCreateFn/challengeRemoveFn receive is therefore ALREADY the
// correct TXT record value; it must NOT be re-hashed here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client, crypto as acmeCrypto, type ClientAutoOptions } from "acme-client";
import type { TlsConfigAcme } from "../config.js";
import { acmeAccountUrlPath } from "../storage.js";
import { ensureAccountKey } from "./account-key.js";
import { Http01ChallengeServer } from "./http01-server.js";
import { formatManualDnsInstructions, pollTxtRecordVisible, runDnsHook } from "./dns01-hook.js";

type ChallengeCreateFn = ClientAutoOptions["challengeCreateFn"];
type ChallengeRemoveFn = ClientAutoOptions["challengeRemoveFn"];

export interface IssuedCertificate {
  /** Fullchain PEM (leaf + intermediates), exactly as returned by the CA. */
  certPem: string;
  keyPem: string;
  notBeforeMs: number;
  notAfterMs: number;
}

export interface IssueCertificateDeps {
  /** Required when challengeType === "http-01"; owned by the caller
   *  (runtime.ts) so the SAME listener instance stays up across both the
   *  initial issuance and every later renewal — no need to rebind
   *  LOOMBRE_HTTP_PORT per attempt. */
  http01Server?: Http01ChallengeServer;
  log?: (message: string) => void;
  /** Test-only: trusts an extra CA (pebble's self-signed test root) via
   *  acme-client's shared axios instance. Never set outside tests —
   *  production ACME talks to Let's Encrypt's publicly trusted chain. */
  trustExtraCaPem?: string;
  /** Test-only: acme-client's auto() self-verifies a challenge (resolving
   *  the domain and connecting directly) BEFORE telling the CA it's ready
   *  — using THIS PROCESS's normal system DNS resolver. That self-check
   *  is exactly right in production (Loombre and the CA both see the same
   *  public DNS) but cannot work against a pebble test domain that only
   *  resolves through pebble-challtestsrv's fake DNS server (which only
   *  pebble itself, running inside the docker network, is configured to
   *  query) — Loombre's own test process, on the host, gets a real
   *  NXDOMAIN for it. Skipping this self-check does NOT weaken what's
   *  being proven: the CA's OWN validation (which DOES use the correct
   *  resolver) is still the real, unskipped, load-bearing check. */
  skipChallengeVerification?: boolean;
  /** Test-only: lets the pebble suite shrink the propagation-poll wait. */
  dnsPollOverride?: { timeoutMs?: number; intervalMs?: number; resolverAddresses?: string[] };
}

let extraCaApplied: string | undefined;

/** acme-client exposes ONE shared axios instance for the whole process
 *  (`export const axios`), so a custom httpsAgent set here is process-
 *  global — fine for tests (one process, one pebble instance) and never
 *  invoked in production. Idempotent: re-applying the same PEM is a
 *  no-op so repeated issuance/renewal calls in the same test process
 *  don't keep replacing the agent. */
async function applyExtraCaTrust(pem: string): Promise<void> {
  if (extraCaApplied === pem) return;
  const https = await import("node:https");
  const { axios: acmeAxios } = await import("acme-client");
  acmeAxios.defaults.httpsAgent = new https.Agent({ ca: pem });
  extraCaApplied = pem;
}

export async function issueCertificate(
  config: TlsConfigAcme,
  deps: IssueCertificateDeps = {},
): Promise<IssuedCertificate> {
  const log = deps.log ?? ((message: string) => console.log(`[tls/acme] ${message}`));

  if (deps.trustExtraCaPem !== undefined) {
    await applyExtraCaTrust(deps.trustExtraCaPem);
  }

  const account = await ensureAccountKey(config.dataDir);
  log(`account key ${account.created ? "generated" : "loaded"} (${account.secretRef.key})`);

  const accountUrlPath = acmeAccountUrlPath(config.dataDir);
  const cachedAccountUrl = existsSync(accountUrlPath) ? readFileSync(accountUrlPath, "utf8").trim() : undefined;

  const client = new Client({
    directoryUrl: config.directoryUrl,
    accountKey: account.pem,
    ...(cachedAccountUrl !== undefined && cachedAccountUrl.length > 0 ? { accountUrl: cachedAccountUrl } : {}),
  });

  const [certKey, csr] = await acmeCrypto.createCsr({
    commonName: config.domains[0] ?? "",
    altNames: config.domains,
  });

  const challengeCreateFn: ChallengeCreateFn = async (authz, challenge, keyAuthorization) => {
    const domain = authz.identifier.value;

    if (challenge.type === "http-01") {
      if (deps.http01Server === undefined) {
        throw new Error("http-01 challenge requested but no Http01ChallengeServer was provided");
      }
      log(`[${domain}] registering http-01 challenge response for token ${challenge.token}`);
      deps.http01Server.register(challenge.token, keyAuthorization);
      return;
    }

    if (challenge.type === "dns-01") {
      const recordName = `_acme-challenge.${domain}`;
      if (config.dnsHookPath !== undefined) {
        log(`[${domain}] running LOOMBRE_ACME_DNS_HOOK set for ${recordName}`);
        await runDnsHook(config.dnsHookPath, "set", recordName, keyAuthorization);
        const seen = await pollTxtRecordVisible(recordName, keyAuthorization, {
          timeoutMs: deps.dnsPollOverride?.timeoutMs ?? config.dnsPropagationTimeoutMs,
          ...(deps.dnsPollOverride?.intervalMs !== undefined ? { intervalMs: deps.dnsPollOverride.intervalMs } : {}),
          ...(deps.dnsPollOverride?.resolverAddresses !== undefined
            ? { resolverAddresses: deps.dnsPollOverride.resolverAddresses }
            : {}),
        });
        if (!seen) {
          log(`[${domain}] WARNING: TXT record not observed as propagated within the poll window — proceeding anyway (the CA's own validation retries are the backstop)`);
        }
        return;
      }

      log(formatManualDnsInstructions(recordName, keyAuthorization));
      const seen = await pollTxtRecordVisible(recordName, keyAuthorization, {
        timeoutMs: deps.dnsPollOverride?.timeoutMs ?? config.dnsPropagationTimeoutMs,
        ...(deps.dnsPollOverride?.intervalMs !== undefined ? { intervalMs: deps.dnsPollOverride.intervalMs } : {}),
        ...(deps.dnsPollOverride?.resolverAddresses !== undefined
          ? { resolverAddresses: deps.dnsPollOverride.resolverAddresses }
          : {}),
      });
      if (!seen) {
        throw new Error(`Timed out waiting for the manually-created TXT record ${recordName}`);
      }
      return;
    }

    throw new Error(`Unsupported ACME challenge type: ${String((challenge as { type: string }).type)}`);
  };

  const challengeRemoveFn: ChallengeRemoveFn = async (authz, challenge, keyAuthorization) => {
    const domain = authz.identifier.value;

    if (challenge.type === "http-01") {
      deps.http01Server?.unregister(challenge.token);
      return;
    }

    if (challenge.type === "dns-01" && config.dnsHookPath !== undefined) {
      const recordName = `_acme-challenge.${domain}`;
      log(`[${domain}] running LOOMBRE_ACME_DNS_HOOK clear for ${recordName}`);
      await runDnsHook(config.dnsHookPath, "clear", recordName, keyAuthorization);
    }
    // Manual dns-01 mode: nothing to automatically clean up — the operator
    // owns the record and may remove it at their convenience.
  };

  const certPem = await client.auto({
    csr,
    ...(config.email !== undefined ? { email: config.email } : {}),
    termsOfServiceAgreed: true,
    challengeCreateFn,
    challengeRemoveFn,
    challengePriority: [config.challengeType],
    ...(deps.skipChallengeVerification !== undefined
      ? { skipChallengeVerification: deps.skipChallengeVerification }
      : {}),
  });

  // Cache the account URL for the NEXT issuance/renewal call (see
  // acmeAccountUrlPath's doc comment) — writeSecretFile isn't used here
  // since an account URL is not a secret (it's the same shape of
  // information a client certificate's own public fields carry), just
  // recorded to avoid a wasted round-trip.
  try {
    writeFileSync(accountUrlPath, client.getAccountUrl());
  } catch {
    // Non-fatal: worst case the next call re-discovers it the slow way.
  }

  const info = acmeCrypto.readCertificateInfo(certPem);

  return {
    certPem: certPem.toString(),
    keyPem: certKey.toString(),
    notBeforeMs: info.notBefore.getTime(),
    notAfterMs: info.notAfter.getTime(),
  };
}
