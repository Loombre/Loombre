// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/reset-token.ts
//
// Self-service password-reset token posture (E3b/M3, STATE.md "Optional
// mail transport & invitation & reset flows"): 256-bit randomBytes(32)
// base64url opaque token, stored as its SHA-256 hex hash — the EXACT same
// shape apps/server/src/session/refresh-token.service.ts's
// generateOpaqueToken/hashToken already use for refresh tokens (M3's own
// adjudication: "same posture as refresh tokens", NOT argon2id — no
// CPU-heavy hashing on the unauthenticated POST /auth/forgot-password /
// POST /auth/reset-password routes, DoS posture). Kept as plain functions
// here rather than folded into RefreshTokenService: that service is
// refresh-token-specific by name and by its own header's stated scope, and
// these two functions carry no state/DI of their own (same "no class
// needed" posture as pin-format.ts's isValidNewPin).

import { createHash, randomBytes } from "node:crypto";

const OPAQUE_TOKEN_BYTES = 32; // 256 bits, same as refresh tokens (M3).

export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes (M15).

/** Plaintext — appears once, in the mailed reset link; never persisted. */
export function generatePasswordResetToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
