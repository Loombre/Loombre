// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/auth.spec.ts

import { describe, expect, it } from "vitest";
import { checkAuth, extractBearerToken, isValidToken } from "./auth.js";

const TOKEN = "a".repeat(64);

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractBearerToken(`BEARER ${TOKEN}`)).toBe(TOKEN);
  });

  it("returns null when the header is missing", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for an array header value", () => {
    expect(extractBearerToken([`Bearer ${TOKEN}`])).toBeNull();
  });

  it("returns null for the wrong scheme", () => {
    expect(extractBearerToken(`Basic ${TOKEN}`)).toBeNull();
  });

  it("returns null for a bare scheme with no token", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });
});

describe("isValidToken", () => {
  it("accepts an exact match", () => {
    expect(isValidToken(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a same-length wrong value", () => {
    expect(isValidToken("b".repeat(64), TOKEN)).toBe(false);
  });

  it("rejects a different-length value without throwing", () => {
    expect(isValidToken("short", TOKEN)).toBe(false);
    expect(isValidToken(TOKEN + "extra", TOKEN)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidToken("", TOKEN)).toBe(false);
  });
});

describe("checkAuth", () => {
  it("passes with a correct Authorization header", () => {
    expect(checkAuth({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });

  it("fails with no Authorization header", () => {
    expect(checkAuth({}, TOKEN)).toBe(false);
  });

  it("fails with a wrong token", () => {
    expect(checkAuth({ authorization: `Bearer ${"z".repeat(64)}` }, TOKEN)).toBe(false);
  });

  it("fails with a malformed header", () => {
    expect(checkAuth({ authorization: TOKEN }, TOKEN)).toBe(false);
  });
});
