// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/refresh-token.service.ts
//
// Opaque 256-bit refresh tokens (task spec, docs/PLAN.md §10): the
// plaintext is handed to the client once and never stored; only its SHA-256
// hash lives in refresh_tokens.token_hash. Rotation happens on EVERY use —
// a successful rotate() revokes the presented row and inserts a new one
// chained via rotated_from. Reuse of an already-rotated/revoked token is
// the token-theft signal: the entire chain (ancestors AND descendants, see
// packages/db/src/query/identity.ts's revokeRefreshTokenChain) is revoked
// and the caller gets a 401.

import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import {
  findRefreshTokenByHash,
  insertRefreshToken,
  revokeRefreshTokenById,
  revokeRefreshTokenChain,
  revokeRefreshTokensForDevice,
  type RefreshTokenRow,
} from "@loombre/db";
import type { LoombreDb } from "../common/db.provider.js";

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (task spec)
const OPAQUE_TOKEN_BYTES = 32; // 256 bits (task spec)

export interface IssuedRefreshToken {
  /** Plaintext — sent to the client once, never persisted. */
  refreshToken: string;
  expiresAtMs: number;
  row: RefreshTokenRow;
}

export type RotateResult =
  | { ok: true; userId: string; deviceId: string | null; issued: IssuedRefreshToken }
  | { ok: false; reason: "invalid" | "expired" | "reused" };

@Injectable()
export class RefreshTokenService {
  generateOpaqueToken(): string {
    return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async issue(
    db: LoombreDb,
    userId: string,
    deviceId: string | null,
    nowMs: number,
    rotatedFrom: string | null = null,
  ): Promise<IssuedRefreshToken> {
    const refreshToken = this.generateOpaqueToken();
    const tokenHash = this.hashToken(refreshToken);
    const expiresAtMs = nowMs + REFRESH_TOKEN_TTL_MS;

    const row = await insertRefreshToken(db, {
      userId,
      deviceId,
      tokenHash,
      issuedAtMs: nowMs,
      expiresAtMs,
      rotatedFrom,
    });

    return { refreshToken, expiresAtMs, row };
  }

  /**
   * Verifies a presented refresh token and, if valid, rotates it: the
   * presented row is revoked and a new row is issued chained via
   * `rotated_from`. Three failure modes, all surfaced to callers as 401:
   *   - "invalid": no row with this hash exists.
   *   - "expired": the row is still un-rotated/un-revoked but past its TTL
   *     — an ordinary expiry, not a theft signal, so the chain is left
   *     alone.
   *   - "reused": the row is already revoked (either normally rotated
   *     already, or previously theft-revoked) — this presentation is a
   *     replay, so the WHOLE chain is revoked before returning.
   */
  async rotate(db: LoombreDb, presentedToken: string, nowMs: number): Promise<RotateResult> {
    const tokenHash = this.hashToken(presentedToken);
    const row = await findRefreshTokenByHash(db, tokenHash);
    if (!row) {
      return { ok: false, reason: "invalid" };
    }

    if (row.revoked_at_ms !== null) {
      await revokeRefreshTokenChain(db, row.id, nowMs);
      return { ok: false, reason: "reused" };
    }

    if (row.expires_at_ms <= nowMs) {
      return { ok: false, reason: "expired" };
    }

    // Compare-and-swap: revocation only succeeds for the caller that first
    // consumes this row. Two concurrent rotations of the same token both
    // pass the reused/expired checks above (their SELECTs run before either
    // UPDATE commits), but only one wins the guarded UPDATE. The loser must
    // NOT mint a second live child — it treats the lost race exactly like a
    // replay of an already-consumed token and revokes the whole chain.
    const won = await revokeRefreshTokenById(db, row.id, nowMs);
    if (!won) {
      await revokeRefreshTokenChain(db, row.id, nowMs);
      return { ok: false, reason: "reused" };
    }
    const issued = await this.issue(db, row.user_id, row.device_id, nowMs, row.id);

    return { ok: true, userId: row.user_id, deviceId: row.device_id, issued };
  }

  /** POST /auth/logout — revokes every still-active token for (userId, deviceId). */
  async logout(db: LoombreDb, userId: string, deviceId: string, nowMs: number): Promise<number> {
    return revokeRefreshTokensForDevice(db, userId, deviceId, nowMs);
  }
}
