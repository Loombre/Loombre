// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/token.service.ts
//
// Access-token layer (docs/PLAN.md §10, task spec): jose HS256 JWTs. Secret
// resolution follows P1.9's "server boots with zero config" spirit: if
// LOOMBRE_JWT_SECRET is set, use it; otherwise derive an ephemeral random
// secret at boot and log a warning. The ephemeral path means every
// restart/every process invalidates all outstanding access tokens (refresh
// tokens are unaffected — they're opaque, hashed, and DB-backed, not
// signed by this secret) and that multi-process deployments MUST set
// LOOMBRE_JWT_SECRET so every process shares one signing key.
//
// Claims: sub (userId), isAdmin, deviceId?, and restrictedUnlocked — the
// gate-5 mirror "recorded on the access token as a claim" (docs/PLAN.md
// §6.4 gate 5). This claim is ADVISORY ONLY: the server-side
// user_settings.restricted_unlocked_until_ms check (via ViewerContextProvider
// / resolveClearance) is authoritative on every request and is re-verified
// live — a stale or forged claim here can never grant clearance on its own.

import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface AccessTokenClaims {
  /** userId */
  sub: string;
  isAdmin: boolean;
  deviceId?: string;
  /** Advisory gate-5 mirror at issuance time — never authoritative. */
  restrictedUnlocked?: boolean;
}

export interface SignedAccessToken {
  token: string;
  expiresAtMs: number;
}

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor() {
    const envSecret = process.env["LOOMBRE_JWT_SECRET"];
    if (envSecret && envSecret.length > 0) {
      this.secret = new TextEncoder().encode(envSecret);
    } else {
      this.secret = randomBytes(32);
      console.warn(
        "[loombre] LOOMBRE_JWT_SECRET is not set — deriving an ephemeral random secret " +
          "for this process (P1.9 zero-config boot). Every access token this process " +
          "signs is invalidated on restart, and no other process can verify them. " +
          "Multi-process deployments MUST set LOOMBRE_JWT_SECRET to a shared value.",
      );
    }
  }

  async signAccessToken(claims: AccessTokenClaims, nowMs: number): Promise<SignedAccessToken> {
    const expiresAtMs = nowMs + ACCESS_TOKEN_TTL_MS;
    const payload: Record<string, unknown> = {
      isAdmin: claims.isAdmin,
      restrictedUnlocked: claims.restrictedUnlocked ?? false,
    };
    if (claims.deviceId !== undefined) {
      payload["deviceId"] = claims.deviceId;
    }

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuedAt(Math.floor(nowMs / 1000))
      .setExpirationTime(Math.floor(expiresAtMs / 1000))
      .sign(this.secret);

    return { token, expiresAtMs };
  }

  /** Throws on any invalid/expired/mis-signed token — callers translate to 401. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("access token missing sub claim");
    }
    const claims: AccessTokenClaims = {
      sub: payload.sub,
      isAdmin: payload["isAdmin"] === true,
      restrictedUnlocked: payload["restrictedUnlocked"] === true,
    };
    if (typeof payload["deviceId"] === "string") {
      claims.deviceId = payload["deviceId"];
    }
    return claims;
  }
}
