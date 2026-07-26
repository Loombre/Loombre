// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/secure-context.ts
//
// The hot-swap primitive (P4.4: "hot-swap the TLS context without dropping
// connections"). `https.Server#setSecureContext()` (Node's own API for
// exactly this) replaces the TLS context used for NEW handshakes; any
// connection whose handshake already completed keeps running under the
// context it negotiated with — this is Node's documented behavior, not
// something Loombre re-implements, which is exactly why nothing already
// connected gets dropped when a manual cert file changes or an ACME
// renewal lands.

import type * as https from "node:https";
import type { SecureContextOptions } from "node:tls";

export interface CertificateMaterial {
  /** PEM. For ACME material this is the fullchain (leaf + intermediates). */
  cert: string;
  key: string;
  /** Extra trust anchors, e.g. a private test CA — production manual/ACME
   *  paths normally leave this unset. */
  ca?: string;
}

export function toSecureContextOptions(material: CertificateMaterial): SecureContextOptions {
  return {
    cert: material.cert,
    key: material.key,
    ...(material.ca !== undefined ? { ca: material.ca } : {}),
  };
}

export function hotSwapCertificate(server: https.Server, material: CertificateMaterial): void {
  server.setSecureContext(toSecureContextOptions(material));
}
