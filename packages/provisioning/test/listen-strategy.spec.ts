// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { LISTEN_STRATEGY_SCHEMA, type ListenStrategy } from "../src/listen-strategy.js";

describe("LISTEN_STRATEGY_SCHEMA", () => {
  const validate = compile(LISTEN_STRATEGY_SCHEMA);

  it("accepts the unix-socket variant", () => {
    const fixture = { kind: "unix-socket", socketDir: "/var/lib/loombre/pg-sock" } satisfies ListenStrategy;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the tcp-loopback variant", () => {
    const fixture = { kind: "tcp-loopback", port: 54329 } satisfies ListenStrategy;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a port on the unix-socket variant (cross-shape mixing)", () => {
    expect(validate({ kind: "unix-socket", socketDir: "/tmp/x", port: 5432 })).toBe(false);
  });

  it("rejects a socketDir on the tcp-loopback variant", () => {
    expect(validate({ kind: "tcp-loopback", port: 5432, socketDir: "/tmp/x" })).toBe(false);
  });

  it("rejects a privileged port below the floor", () => {
    expect(validate({ kind: "tcp-loopback", port: 80 })).toBe(false);
  });

  it("rejects a port above the TCP max", () => {
    expect(validate({ kind: "tcp-loopback", port: 70000 })).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(validate({ kind: "named-pipe", socketDir: "\\\\.\\pipe\\loombre-pg" })).toBe(false);
  });
});
