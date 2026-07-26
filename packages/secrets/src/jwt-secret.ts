// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/jwt-secret.ts
//
// Deliverable 5 / STATE.md P4.17: "server boot resolves LOOMBRE_JWT_SECRET
// env -> secrets store -> generate+persist (env always wins)". Kills the
// ephemeral-fallback footgun apps/server/src/session/token.service.ts's own
// header documents today ("deriving an ephemeral random secret for this
// process ... every access token this process signs is invalidated on
// restart") for the zero-config (no LOOMBRE_JWT_SECRET set) install case —
// after the FIRST boot, the generated secret is durable, so a restart keeps
// every outstanding access token valid instead of silently logging everyone
// out.
//
// Key shape: callers supply ONE stable identifier (`key`) used verbatim
// across every backend — packages/secrets stays decoupled from any
// particular app's app-data-directory resolver (apps/server/src/cli/
// app-paths.ts is CLI-only and this package must not depend on an app), so
// the caller (apps/server/src/main.ts) computes an ABSOLUTE PATH under its
// own resolved data dir (e.g. `<dataDir>/secrets/jwt-signing-secret`) and
// passes it in. Only the file0600 backend actually treats `key` as a
// filesystem path; keychain/dpapi/libsecret store it as an opaque
// account-name string, which a full absolute path serves perfectly well as
// (a little unusual to look at in Keychain Access, functionally identical
// to any other string). Rejected alternative: a separate short "pretty"
// logical name per backend — that reintroduces exactly the two-key-spaces
// problem migrateSecret()'s "reuse the same key across backends" design
// exists to avoid (this module's own migration step below would otherwise
// need a key-translation table between the file path and the pretty name).
//
// Resolution order (env always wins, never overwritten by this module):
//   1. process.env.LOOMBRE_JWT_SECRET, verbatim, if set and non-empty.
//   2. Auto-detect this platform's SecretBackend (detect.ts). If a secret
//      already exists at `key` under file0600 (the universal fallback every
//      platform can always write) AND the detected backend is a DIFFERENT
//      (better) one, migrate it there first (deliverable 5's "file->keychain
//      on first boot where available") — this is the one case this module
//      does more than a bare generate-or-resolve, because an operator who
//      installed before a native store became available/supported must not
//      get a NEW secret (silent mass logout) just because the detected
//      backend changed under them.
//   3. Otherwise resolve-or-generate directly on the detected backend
//      (SecretBackendImpl.generate() is already idempotent).
//
// This module never reads/writes LOOMBRE_JWT_SECRET itself — it returns the
// resolved plaintext value and lets the caller (apps/server/src/main.ts)
// decide what to do with it (today: seed process.env before TokenService's
// constructor runs, so that class's existing "env or ephemeral" logic picks
// up a value that happens to already be durable — zero changes needed to
// token.service.ts itself).

import type { SecretBackend } from "@loombre/provisioning";
import { detectSecretBackend, type DetectBackendEnv } from "./detect.js";
import { generateSecret, tryResolveSecret } from "./store.js";
import { migrateSecret } from "./migrate.js";

export interface ResolveJwtSecretEnv extends DetectBackendEnv {
  LOOMBRE_JWT_SECRET?: string | undefined;
}

export interface ResolveJwtSecretResult {
  secret: string;
  source: "env" | "migrated" | "existing" | "generated";
  backend?: SecretBackend;
}

export interface ResolveJwtSecretOptions {
  /** Stable identifier reused verbatim across every backend — see this
   *  module's header. Callers should pass an absolute path under their
   *  app-data directory. */
  key: string;
  env?: ResolveJwtSecretEnv;
  platform?: NodeJS.Platform;
}

export async function resolveJwtSecret(opts: ResolveJwtSecretOptions): Promise<ResolveJwtSecretResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const key = opts.key;

  const envSecret = env.LOOMBRE_JWT_SECRET?.trim();
  if (envSecret) {
    return { secret: envSecret, source: "env" };
  }

  const { backend } = await detectSecretBackend(env, platform);

  if (backend !== "file0600") {
    const legacyFileValue = await tryResolveSecret({ backend: "file0600", key });
    if (legacyFileValue !== null) {
      const migration = await migrateSecret({ backend: "file0600", key }, backend);
      return {
        secret: legacyFileValue,
        source: migration.migrated ? "migrated" : "existing",
        backend: migration.ref.backend,
      };
    }
  }

  const existing = await tryResolveSecret({ backend, key });
  if (existing !== null) {
    return { secret: existing, source: "existing", backend };
  }

  const generated = await generateSecret(backend, key);
  return { secret: generated.value, source: "generated", backend: generated.ref.backend };
}
