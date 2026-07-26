// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { IPC_DISCOVERY_FILE_SCHEMA, type IpcDiscoveryFile } from "../src/transport.js";

describe("IPC_DISCOVERY_FILE_SCHEMA", () => {
  const validate = compile(IPC_DISCOVERY_FILE_SCHEMA);

  it("accepts a well-formed discovery file", () => {
    const fixture = {
      port: 54871,
      host: "127.0.0.1",
      pid: 4821,
      startedAtMs: 1_800_000_000_000,
    } satisfies IpcDiscoveryFile;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a non-loopback host (the transport must never be LAN-reachable)", () => {
    expect(validate({ port: 54871, host: "0.0.0.0", pid: 1, startedAtMs: 0 })).toBe(false);
  });

  it("rejects a port outside the valid TCP range", () => {
    expect(validate({ port: 0, host: "127.0.0.1", pid: 1, startedAtMs: 0 })).toBe(false);
    expect(validate({ port: 70000, host: "127.0.0.1", pid: 1, startedAtMs: 0 })).toBe(false);
  });

  it("rejects a missing pid", () => {
    expect(validate({ port: 54871, host: "127.0.0.1", startedAtMs: 0 })).toBe(false);
  });
});
