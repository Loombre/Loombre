// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import type { ProvisioningStatus } from "@loombre/provisioning";
import {
  CONTROLLER_IPC_CONTRACT_VERSION,
  IPC_STATUS_RESPONSE_SCHEMA,
  type IpcStatusResponse,
  type ProcessInfo,
} from "../src/index.js";

function process(state: ProcessInfo["state"]): ProcessInfo {
  return {
    state,
    pid: state === "running" ? 4821 : null,
    startedAtMs: state === "running" ? 1_800_000_000_000 : null,
    version: "0.1.0",
  };
}

describe("IPC_STATUS_RESPONSE_SCHEMA", () => {
  const validate = compile(IPC_STATUS_RESPONSE_SCHEMA);

  it("accepts a well-formed status response, embedding a real ProvisioningStatus", () => {
    const provisioning = {
      state: "ready",
      pgVersion: "17.4",
      dataDir: "/var/lib/loombre/pgdata",
      lastCheckMs: 1_800_000_000_000,
    } satisfies ProvisioningStatus;

    const fixture = {
      ipcContractVersion: CONTROLLER_IPC_CONTRACT_VERSION,
      server: process("running"),
      worker: process("running"),
      webUrl: "http://127.0.0.1:8080",
      provisioning,
    } satisfies IpcStatusResponse;

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a null webUrl while the server is not serving the web client", () => {
    const fixture = {
      ipcContractVersion: CONTROLLER_IPC_CONTRACT_VERSION,
      server: process("stopped"),
      worker: process("stopped"),
      webUrl: null,
      provisioning: {
        state: "absent",
        pgVersion: null,
        dataDir: null,
        lastCheckMs: 0,
      },
    } satisfies IpcStatusResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects an invalid nested ProvisioningStatus (the shared schema is actually enforced, not just typed)", () => {
    const fixture = {
      ipcContractVersion: CONTROLLER_IPC_CONTRACT_VERSION,
      server: process("running"),
      worker: process("running"),
      webUrl: "http://127.0.0.1:8080",
      provisioning: {
        state: "installing", // not in @loombre/provisioning's PROVISIONING_STATES
        pgVersion: null,
        dataDir: null,
        lastCheckMs: 0,
      },
    };
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a missing ipcContractVersion", () => {
    const fixture = {
      server: process("running"),
      worker: process("running"),
      webUrl: null,
      provisioning: { state: "absent", pgVersion: null, dataDir: null, lastCheckMs: 0 },
    };
    expect(validate(fixture)).toBe(false);
  });
});
