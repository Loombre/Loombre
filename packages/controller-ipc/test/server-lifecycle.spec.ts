// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  IPC_SERVER_START_REQUEST_SCHEMA,
  IPC_SERVER_START_RESPONSE_SCHEMA,
  IPC_SERVER_STOP_REQUEST_SCHEMA,
  IPC_SERVER_STOP_RESPONSE_SCHEMA,
  type IpcServerStartRequest,
  type IpcServerStartResponse,
  type IpcServerStopRequest,
  type IpcServerStopResponse,
} from "../src/index.js";

describe("server/start", () => {
  it("request schema accepts only an empty object", () => {
    const validate = compile(IPC_SERVER_START_REQUEST_SCHEMA);
    const empty = {} satisfies IpcServerStartRequest;
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ force: true })).toBe(false);
  });

  it("response schema accepts accepted+state, rejects an out-of-enum state", () => {
    const validate = compile(IPC_SERVER_START_RESPONSE_SCHEMA);
    const fixture = { accepted: true, state: "starting" } satisfies IpcServerStartResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ accepted: true, state: "booting" })).toBe(false);
  });

  it("response schema accepts accepted:false for a no-op (already running)", () => {
    const validate = compile(IPC_SERVER_START_RESPONSE_SCHEMA);
    const fixture = { accepted: false, state: "running" } satisfies IpcServerStartResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("server/stop", () => {
  it("request schema accepts only an empty object", () => {
    const validate = compile(IPC_SERVER_STOP_REQUEST_SCHEMA);
    const empty = {} satisfies IpcServerStopRequest;
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ graceful: true })).toBe(false);
  });

  it("response schema accepts accepted+state", () => {
    const validate = compile(IPC_SERVER_STOP_RESPONSE_SCHEMA);
    const fixture = { accepted: true, state: "stopping" } satisfies IpcServerStopResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("response schema rejects a missing accepted field", () => {
    const validate = compile(IPC_SERVER_STOP_RESPONSE_SCHEMA);
    expect(validate({ state: "stopped" })).toBe(false);
  });
});
