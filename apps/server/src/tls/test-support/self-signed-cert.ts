// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/test-support/self-signed-cert.ts
//
// Generates a throwaway self-signed cert+key via the system `openssl`
// binary (present on every CI runner this repo targets — ubuntu-latest
// ships it, and it's what packages/db's own test scripts already assume
// is on PATH for other purposes). Used only by TLS test suites that need
// a REAL certificate to hand to `https.createServer`/`tls.connect` —
// never shipped, never touches acme-client or a network.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SelfSignedCert {
  cert: string;
  key: string;
  cleanup: () => void;
}

export function generateSelfSignedCert(commonName = "localhost"): SelfSignedCert {
  const dir = mkdtempSync(join(tmpdir(), "loombre-selfsigned-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    `subjectAltName=DNS:${commonName}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  return {
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
