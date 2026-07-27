// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/discovery.ts
//
// The READER half of the single-provisioner rule (STATE.md P4.2): only
// apps/server provisions and supervises the embedded postmaster; any
// sibling process (apps/worker is the one that exists today) obtains the
// SAME DATABASE_URL by reading the same superuser secret the provisioner
// wrote — through the same secret-backend seam, never via a second copy
// of the credentials on disk and never by provisioning anything itself.
//
// Path convention: the provisioner (apps/server/src/bootstrap/
// provisioning.ts) derives its secret path from embeddedSuperuserSecretPath
// below — the ONE definition — so reader and writer cannot drift.
//
// A null return means "the provisioner has not run (yet)" — callers that
// expect a server to appear (the worker's boot path) poll; callers that
// don't should treat null as "embedded mode is not in play here".

import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildDatabaseUrl } from "./listen.js";
import { resolveSecret } from "./secret/resolve.js";
import {
  EMBEDDED_PG_DEFAULT_DATABASE,
  EMBEDDED_PG_DEFAULT_PORT,
  EMBEDDED_PG_SUPERUSER_USERNAME,
} from "./defaults.js";

/** `<dataDir>/postgres/superuser.secret` — the file0600-protected secret
 *  the provisioner generates at first provision. */
export function embeddedSuperuserSecretPath(dataDir: string): string {
  return join(dataDir, "postgres", "superuser.secret");
}

export interface EmbeddedDiscoveryOptions {
  /** The SAME data dir the provisioning server runs with
   *  (LOOMBRE_DATA_DIR in packaged installs). */
  dataDir: string;
  /** Must match the provisioner's listen port
   *  (LOOMBRE_EMBEDDED_PG_PORT, default EMBEDDED_PG_DEFAULT_PORT). */
  port?: number;
  username?: string;
  database?: string;
}

/**
 * One-shot discovery: the embedded DATABASE_URL if the provisioner's
 * secret exists, null if it does not (yet). Never creates anything.
 */
export async function resolveEmbeddedDatabaseUrl(options: EmbeddedDiscoveryOptions): Promise<string | null> {
  const secretPath = embeddedSuperuserSecretPath(options.dataDir);
  if (!existsSync(secretPath)) {
    return null;
  }
  const secret = await resolveSecret({ backend: "file0600", key: secretPath });
  return buildDatabaseUrl(
    { kind: "tcp-loopback", port: options.port ?? EMBEDDED_PG_DEFAULT_PORT },
    options.username ?? EMBEDDED_PG_SUPERUSER_USERNAME,
    secret,
    options.database ?? EMBEDDED_PG_DEFAULT_DATABASE,
  );
}

export { EMBEDDED_PG_DEFAULT_PORT } from "./defaults.js";
