// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/cert-store.ts
//
// Persists/loads the ACME-issued certificate under the app-data dir
// (storage.ts's acmeCertPath/acmeCertKeyPath), both 0600. Deliberately
// carries NO separate "expiry" metadata file — notBefore/notAfter are
// always recomputed from the certificate PEM itself via acme-client's
// own readCertificateInfo, so there is no cached value that can drift
// from what the cert actually says.

import { existsSync, readFileSync } from "node:fs";
import { crypto as acmeCrypto } from "acme-client";
import { writeSecretFile } from "../fs-secret.js";
import { acmeCertKeyPath, acmeCertPath } from "../storage.js";
import type { IssuedCertificate } from "./issue-certificate.js";

export function persistIssuedCertificate(dataDir: string, cert: IssuedCertificate): void {
  writeSecretFile(acmeCertPath(dataDir), cert.certPem);
  writeSecretFile(acmeCertKeyPath(dataDir), cert.keyPem);
}

export function loadPersistedCertificate(dataDir: string): IssuedCertificate | undefined {
  const certPath = acmeCertPath(dataDir);
  const keyPath = acmeCertKeyPath(dataDir);
  if (!existsSync(certPath) || !existsSync(keyPath)) return undefined;

  const certPem = readFileSync(certPath, "utf8");
  const keyPem = readFileSync(keyPath, "utf8");
  const info = acmeCrypto.readCertificateInfo(certPem);

  return {
    certPem,
    keyPem,
    notBeforeMs: info.notBefore.getTime(),
    notAfterMs: info.notAfter.getTime(),
  };
}
