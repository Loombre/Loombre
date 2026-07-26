// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/auth.ts
//
// Bearer-token auth for every request into the loopback listener —
// transport.ts: "Convention every request (except discovery-file reads,
// which are local filesystem, not HTTP) authenticates with `Authorization:
// Bearer <token>`" — i.e. literally every HTTP request this listener ever
// serves, no anonymous health-check path, no exceptions.
//
// THREAT MODEL: loopback (127.0.0.1) + a random 32-byte bearer token that
// only a process able to READ the token file (posix-permissions.ts /
// windows-acl.ts's access-control story) can ever present. This is a LOCAL
// TRUST boundary, not a network one — stop/status/etc. are local-admin
// capabilities, deliberately never LAN-exposed (transport.ts binds
// 127.0.0.1 explicitly, see listener.ts's own loopback-only proof). The
// token's job is narrower than "keep out the internet" (loopback binding
// already does that): it stops any OTHER local process/user on a
// multi-user box from calling stop/server-lifecycle/crash-file-listing
// just because they can reach 127.0.0.1 — TCP loopback has no per-process
// or per-user access control of its own, so without a token every local
// process could otherwise send this listener a request.
//
// The token is NEVER logged — every log line in this package that
// mentions auth failures logs the fact of failure, never the presented
// value (see checkAuth's caller in listener.ts).

import { timingSafeEqual } from "node:crypto";
import { IPC_AUTH_HEADER, IPC_AUTH_SCHEME } from "@loombre/controller-ipc";

/** Extracts the raw token from an incoming Authorization header value, or
 *  null if the header is missing/malformed (wrong scheme, empty). Case-
 *  insensitive on the scheme per RFC 9110 §11.1. */
export function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const prefix = `${IPC_AUTH_SCHEME} `;
  if (headerValue.length <= prefix.length) return null;
  if (headerValue.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  const token = headerValue.slice(prefix.length);
  return token.length > 0 ? token : null;
}

/** Constant-time comparison against the listener's own current token.
 *  `timingSafeEqual` throws if the two buffers differ in length — an
 *  attacker-controlled length would otherwise itself be a timing oracle
 *  ("how long is the real token"), so a length mismatch is treated as an
 *  immediate, still-constant-time-relative-to-guessing failure rather than
 *  caught-and-compared-anyway (there is nothing meaningful to compare once
 *  lengths differ; the real token's length is fixed at 64 hex chars by
 *  generateIpcToken, so any presented token of a different length is
 *  trivially wrong, and rejecting it without a compare leaks only the fact
 *  "wrong length", not "wrong length by how much" or any content). */
export function isValidToken(presented: string, expected: string): boolean {
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/** Header lookup helper — node:http lower-cases incoming header names, and
 *  IPC_AUTH_HEADER is already lower-case ("authorization"), but this stays
 *  explicit rather than assumed. */
export function checkAuth(headers: Record<string, string | string[] | undefined>, expectedToken: string): boolean {
  const token = extractBearerToken(headers[IPC_AUTH_HEADER]);
  if (token === null) return false;
  return isValidToken(token, expectedToken);
}
