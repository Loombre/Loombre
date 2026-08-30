// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/link-sealing.ts
//
// Mail jobs carrying an invite-claim or password-reset link persist only
// a reference plus the recipient — never the live plaintext token — with
// the worker building the URL at send time from the effective
// network.publicUrl (MRV-R1). Without this, the full tokened URL rides
// pgboss.job.data (and its archive), harvestable by anyone with DB read
// access.
//
// The reference is a SEALED token: AES-256-GCM over the plaintext, keyed
// by a per-install secret both processes reach through the same keyring
// mechanics mail's SMTP credentials already prove work cross-process
// (server writes, worker reads, <dataDir>/secrets/*). Sealing — not
// worker-side re-minting — because the invite's emailed link must stay
// the SAME artifact as the claimUrl the create response hands the admin
// (E2's law); a re-mint would silently kill the admin's copied link the
// moment the mail job ran.
//
// Key shape: same one-stable-identifier contract as jwt-secret.ts (the
// caller passes an absolute `<dataDir>/secrets/mail-link-sealing-key`
// path; only file0600 treats it as a path). Resolution is a plain
// detect -> read -> generate-and-persist — deliberately NO env override
// and NO cross-backend lookback migration (jwt-secret.ts's hazard is a
// silent mass logout; here the blast radius of a lost key is a mail job
// failing terminally within its ~15-min retry window and the admin
// re-triggering — not worth the machinery). The stored secret is
// generateSecret()'s opaque string; the actual 32-byte AES key is
// SHA-256 of it, decoupling this module from any backend's generated
// format.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { detectSecretBackend } from "./detect.js";
import { generateSecret, tryResolveSecret } from "./store.js";
import type { DetectBackendEnv } from "./detect.js";

const SEALED_PREFIX = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class LinkSealError extends Error {
  constructor(message: string) {
    // Never echoes sealed or plaintext content — callers log this message.
    super(message);
    this.name = "LinkSealError";
  }
}

export interface ResolveLinkSealingKeyOptions {
  /** Stable identifier, e.g. `<dataDir>/secrets/mail-link-sealing-key`. */
  key: string;
  env?: DetectBackendEnv;
  platform?: NodeJS.Platform;
}

/** Read-or-create the per-install sealing secret. The server resolves
 *  (creating on first use) BEFORE enqueueing a sealed payload, so by the
 *  time the worker resolves it the secret always exists — the worker
 *  treats absence as a hard job failure, never a silent skip. */
export async function resolveLinkSealingSecret(opts: ResolveLinkSealingKeyOptions): Promise<string> {
  const detected = await detectSecretBackend(opts.env ?? process.env, opts.platform ?? process.platform);
  const existing = await tryResolveSecret({ backend: detected.backend, key: opts.key });
  if (existing !== null) return existing;
  const generated = await generateSecret(detected.backend, opts.key);
  return generated.value;
}

function aesKey(sealingSecret: string): Buffer {
  return createHash("sha256").update(sealingSecret, "utf8").digest();
}

/** `v1.<iv>.<ciphertext>.<tag>`, all base64url — opaque to a DB reader. */
export function sealLinkToken(sealingSecret: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aesKey(sealingSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEALED_PREFIX, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function unsealLinkToken(sealingSecret: string, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEALED_PREFIX) {
    throw new LinkSealError("sealed link token is malformed (expected v1.<iv>.<ciphertext>.<tag>)");
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const ciphertext = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new LinkSealError("sealed link token is malformed (bad iv/tag length)");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey(sealingSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new LinkSealError("sealed link token failed authentication (wrong key or tampered payload)");
  }
}
