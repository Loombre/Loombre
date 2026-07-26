// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/runtime.ts
//
// Top-level orchestration main.ts calls: given a resolved TlsConfig and
// the Express request listener, produce either `null` (mode=off — the
// caller keeps using plain `app.listen()`, byte-identical to before this
// module existed) or a live `https.Server` wired up for its mode:
//
//   manual — loads cert/key from disk, watches for changes, hot-swaps.
//   acme   — loads a persisted cert if one exists and isn't already due
//            for renewal, otherwise issues a fresh one; starts the daily
//            renewal-check loop; hot-swaps on every successful renewal.

import * as https from "node:https";
import type { RequestListener } from "node:http";
import type { TlsConfig } from "./config.js";
import { hotSwapCertificate, toSecureContextOptions, type CertificateMaterial } from "./secure-context.js";
import { readManualCertificate, watchManualCertificate } from "./manual-provider.js";
import { isWithinRenewalWindow, startRenewalScheduler } from "./renewal.js";
import { Http01ChallengeServer } from "./acme/http01-server.js";
import { issueCertificate, type IssueCertificateDeps } from "./acme/issue-certificate.js";
import { loadPersistedCertificate, persistIssuedCertificate } from "./acme/cert-store.js";

export interface TlsRuntime {
  /** null exactly when config.mode === "off". */
  server: https.Server | null;
  close: () => Promise<void>;
}

export interface CreateTlsRuntimeOptions {
  log?: (message: string) => void;
  /** Forwarded to issue-certificate.ts — test-only pebble trust anchor +
   *  DNS-01 poll tuning. Never set in production. */
  acmeTestDeps?: Pick<IssueCertificateDeps, "trustExtraCaPem" | "dnsPollOverride" | "skipChallengeVerification">;
}

function closeHttpsServer(server: https.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function createTlsRuntime(
  config: TlsConfig,
  requestListener: RequestListener,
  opts: CreateTlsRuntimeOptions = {},
): Promise<TlsRuntime> {
  const log = opts.log ?? ((message: string) => console.log(`[tls] ${message}`));

  if (config.mode === "off") {
    return { server: null, close: async () => {} };
  }

  if (config.mode === "manual") {
    const material = readManualCertificate(config);
    const server = https.createServer(toSecureContextOptions(material), requestListener);
    const stopWatching = watchManualCertificate(
      config,
      (updated: CertificateMaterial) => {
        hotSwapCertificate(server, updated);
        log(`manual TLS certificate reloaded from ${config.certPath}`);
      },
      { debounceMs: config.reloadDebounceMs },
    );
    return {
      server,
      close: async () => {
        stopWatching();
        await closeHttpsServer(server);
      },
    };
  }

  // acme
  const http01Server = config.challengeType === "http-01" ? new Http01ChallengeServer({ redirectHttpsPort: config.httpsPort }) : undefined;
  if (http01Server !== undefined) {
    await http01Server.listen(config.httpPort);
    log(`http-01 challenge listener bound on port ${config.httpPort}`);
  }

  const issueDeps: IssueCertificateDeps = {
    ...(http01Server !== undefined ? { http01Server } : {}),
    log,
    ...opts.acmeTestDeps,
  };

  let current = loadPersistedCertificate(config.dataDir);
  if (current === undefined || isWithinRenewalWindow(current.notAfterMs, Date.now(), config.renewWindowDays)) {
    log(current === undefined ? "no persisted certificate — issuing a fresh one" : "persisted certificate is within its renewal window — renewing before serving");
    current = await issueCertificate(config, issueDeps);
    persistIssuedCertificate(config.dataDir, current);
  } else {
    log(`loaded persisted certificate (expires ${new Date(current.notAfterMs).toISOString()})`);
  }

  const server = https.createServer(toSecureContextOptions({ cert: current.certPem, key: current.keyPem }), requestListener);

  const stopRenewal = startRenewalScheduler(
    async () => {
      const cert = current;
      if (cert === undefined || !isWithinRenewalWindow(cert.notAfterMs, Date.now(), config.renewWindowDays)) return;
      log("certificate is within its renewal window — renewing");
      const renewed = await issueCertificate(config, issueDeps);
      persistIssuedCertificate(config.dataDir, renewed);
      hotSwapCertificate(server, { cert: renewed.certPem, key: renewed.keyPem });
      current = renewed;
      log(`renewal complete, hot-swapped (expires ${new Date(renewed.notAfterMs).toISOString()})`);
    },
    { checkIntervalMs: config.renewCheckIntervalMs, onError: (err) => log(`renewal check failed: ${String(err)}`) },
  );

  return {
    server,
    close: async () => {
      stopRenewal();
      if (http01Server !== undefined) await http01Server.close();
      await closeHttpsServer(server);
    },
  };
}
