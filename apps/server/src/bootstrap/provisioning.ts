// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/bootstrap/provisioning.ts
//
// STATE.md P4.2 / this lane's mission deliverable 3: the ONE seam apps/
// server uses to obtain a working DATABASE_URL before Nest constructs
// anything. Called at the very top of main.ts's bootstrap(), before
// `NestFactory.create` — see that file's one-line wiring edit.
//
//   DATABASE_URL already set in the environment -> external mode. Done,
//   done inertly and quickly (ExternalPostgresProvisioner never touches
//   disk/process state) — D1 "external PG via env var" stays first-class.
//
//   Otherwise -> embedded mode: resolve this platform's pinned binaries
//   (fetched ahead of time by scripts/fetch-embedded-pg.mjs — this file
//   never downloads anything itself, matching CLAUDE.md invariant 6 "long-
//   running work goes through the job queue; nothing spawns ffmpeg [or,
//   here, a multi-MB network fetch] inline" in spirit for a request-adjacent
//   boot path), provision + start a real @loombre/provisioning-pg
//   EmbeddedPostgres instance under the platform-correct app-data dir
//   (apps/server/src/cli/app-paths.ts's resolveAppPaths — reused verbatim,
//   not reimplemented, per that file's own "a later wave... can delegate to
//   it" invitation), and export the resulting DATABASE_URL into
//   process.env so the EXISTING pool init (DbProvider, job-queue.provider —
//   both already read process.env["DATABASE_URL"] with a fallback default)
//   picks it up with ZERO changes of their own.
//
// Worker contract (documented here since this is the one file that decides
// embedded-vs-external): the worker process does NOT provision anything
// itself (single-provisioner rule — only the server owns the child
// postmaster). It receives the SAME DATABASE_URL via its own environment,
// supplied by whichever service manager started it (installer lanes'
// systemd unit / Windows service / launchd plist / docker-compose — each
// sets DATABASE_URL for both the server and worker units from the same
// source). If the worker starts before the server has finished
// provisioning (or DATABASE_URL simply is not reachable yet), see this
// package's README "Worker contract" section and apps/worker/src/index.ts's
// `waitForDatabaseReady` guard (this lane's mission deliverable 3's
// explicitly-authorized "tiny guard in worker db-connect error handling").

import { resolveAppPaths } from "../cli/app-paths.js";
import { runPendingMigrations } from "@loombre/db/migrate";
import {
  EMBEDDED_PG_DEFAULT_PORT,
  EmbeddedPostgres,
  ExternalPostgresProvisioner,
  embeddedSuperuserSecretPath,
  resolveEmbeddedPgPlatform,
  resolveVendorBinaries,
  type ProvisioningController,
} from "@loombre/provisioning-pg";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The pg major/full version this build's apps/server expects to find
 *  vendored alongside it — MUST match whatever
 *  `node scripts/fetch-embedded-pg.mjs` was run with at build/install time
 *  (installer lanes I1/I3/I4 own that pairing). Overridable per-install via
 *  LOOMBRE_EMBEDDED_PG_VERSION for an operator who has vendored a different
 *  pinned minor. */
export const EMBEDDED_PG_DEFAULT_VERSION = "18.4.0";
// Re-exported from @loombre/provisioning-pg's shared defaults (P4.2
// discovery seam: apps/worker reconstructs the same URL and must agree
// on this port) — no longer pinned independently here.
export { EMBEDDED_PG_DEFAULT_PORT } from "@loombre/provisioning-pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-checkout convenience default: `<repo-root>/vendor/embedded-pg`,
 * resolved relative to THIS file's own compiled location (works whether
 * running via tsx from src/ or node from dist/, since both sit at the same
 * depth under apps/server/src|dist).
 *
 * DISCOVERY for installer lanes I1/I3/I4: a PACKAGED install has no
 * "repo root" — this default will not resolve correctly once apps/server
 * ships as a bundled artifact outside this monorepo's directory layout.
 * Every packaging lane MUST set LOOMBRE_EMBEDDED_PG_VENDOR_DIR to wherever
 * it placed the fetched binaries (e.g. alongside the installed app, per
 * that platform's own layout conventions) — this is a hard requirement,
 * not a nice-to-have, documented again in packages/provisioning-pg/README.md.
 */
function defaultVendorDir(): string {
  return resolve(__dirname, "..", "..", "..", "..", "vendor", "embedded-pg");
}

export interface BootstrapProvisioningResult {
  controller: ProvisioningController;
  databaseUrl: string;
  mode: "external" | "embedded";
}

let currentController: ProvisioningController | null = null;

/**
 * Deliverable 4 (corruption-recovery surfacing): exposes the live
 * controller so lane D's admin UI (via a future HTTP endpoint THEY own)
 * and lane C's onboarding wizard can read getCurrentProvisioningStatus().
 * Null until bootstrapProvisioning() has run at least once this process.
 */
export function getProvisioningController(): ProvisioningController | null {
  return currentController;
}

export async function bootstrapProvisioning(env: NodeJS.ProcessEnv = process.env): Promise<BootstrapProvisioningResult> {
  const externalUrl = env["DATABASE_URL"]?.trim();
  if (externalUrl) {
    const controller = new ExternalPostgresProvisioner(externalUrl);
    currentController = controller;
    return { controller, databaseUrl: externalUrl, mode: "external" };
  }

  const platform = resolveEmbeddedPgPlatform(process.platform, process.arch);
  if (!platform) {
    throw new Error(
      `@loombre/server bootstrap: no embedded-PostgreSQL binaries are pinned for ${process.platform}/${process.arch}. ` +
        "Set DATABASE_URL to point at an external PostgreSQL instance instead (D1).",
    );
  }

  const { dataDir } = resolveAppPaths(process.platform, env);
  const pgDataDir = join(dataDir, "postgres", "data");
  // Via the package's ONE path definition — apps/worker's discovery seam
  // (resolveEmbeddedDatabaseUrl) reads the same helper, so writer and
  // reader cannot drift (P4.2).
  const secretPath = embeddedSuperuserSecretPath(dataDir);

  const vendorDir = env["LOOMBRE_EMBEDDED_PG_VENDOR_DIR"]?.trim() || defaultVendorDir();
  const pgFullVersion = env["LOOMBRE_EMBEDDED_PG_VERSION"]?.trim() || EMBEDDED_PG_DEFAULT_VERSION;
  const pgMajor = Number.parseInt(pgFullVersion, 10);
  const portEnv = env["LOOMBRE_EMBEDDED_PG_PORT"]?.trim();
  const port = portEnv ? Number.parseInt(portEnv, 10) : EMBEDDED_PG_DEFAULT_PORT;

  const binaries = resolveVendorBinaries(vendorDir, platform, pgFullVersion);

  const instance = new EmbeddedPostgres({
    binaries,
    pgMajor,
    pgFullVersion,
    dataDir: pgDataDir,
    // TCP loopback, not unix-socket, by deliberate default here: LOOMBRE_DATA_DIR
    // resolves to a platform app-data path (e.g. macOS's
    // "~/Library/Application Support/Loombre") whose length is entirely up
    // to the OS/username/localization — a unix socket's ~104-byte sun_path
    // cap is a REAL failure this lane hit and fixed in its own integration
    // tests (see packages/provisioning-pg/src/scratch-paths.ts). TCP
    // loopback has no such landmine and is equally "localhost-only" per
    // P4.2 — 127.0.0.1 is hard-coded inside @loombre/provisioning-pg's
    // listen.ts, never configurable to anything else.
    listenStrategy: { kind: "tcp-loopback", port },
    // builtin C.UTF-8 (PG 17+), NOT a libc locale: packaged hosts —
    // minimal containers especially — generate no OS locales, and initdb
    // rejects an absent one ("invalid locale name en_US.UTF-8", the linux
    // smoke's first honest embedded boot). The builtin provider gives
    // full UTF-8 ctype semantics with OS-independent byte-order
    // collation — deterministic across every platform we ship. Follow-up
    // (STATE.md): linguistic sort order via ICU is a later, per-database
    // choice, not a boot-time requirement.
    locale: "C.UTF-8",
    localeProvider: "builtin",
    encoding: "UTF8",
    superuserSecretRef: { backend: "file0600", key: secretPath },
  });

  currentController = instance;

  await instance.provision();
  const status = await instance.start();
  if (status.state !== "ready") {
    throw new Error(
      `@loombre/server bootstrap: embedded PostgreSQL failed to reach 'ready' (state=${status.state}, detail=${status.detail ?? "none"}). ` +
        "See getProvisioningController().getCurrentProvisioningStatus() for the typed CorruptionReport once one is generated.",
    );
  }

  // Best-effort process-exit safety net — NOT a substitute for a real
  // graceful SIGTERM handler (STATE.md P4.14, a separate deliverable this
  // lane does not own): see EmbeddedPostgres.killSync()'s own doc comment.
  process.once("exit", () => instance.killSync());

  const databaseUrl = instance.getDatabaseUrl();

  // EMBEDDED MODE ONLY: apply pending schema migrations at boot. This
  // cluster is exclusively ours (single-provisioner rule) and migrations
  // are forward-only (docs/PLAN.md, H4), so auto-migration is safe here —
  // and REQUIRED: an installed deployment has no repo checkout or pnpm to
  // run the dev CLI from; without this, first boot provisions a
  // schema-less database and the app dies on its first query (installer
  // completeness audit). External mode deliberately never migrates — an
  // operator's database is not ours to alter unprompted.
  await runPendingMigrations(databaseUrl, {
    log: (message) => console.log(`[bootstrap] ${message}`),
  });

  return { controller: instance, databaseUrl, mode: "embedded" };
}
