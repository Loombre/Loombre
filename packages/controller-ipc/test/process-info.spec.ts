// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import { PROCESS_INFO_SCHEMA, PROCESS_STATES, type ProcessInfo } from "../src/process-info.js";

describe("PROCESS_INFO_SCHEMA", () => {
  const validate = compile(PROCESS_INFO_SCHEMA);

  it("accepts every closed state with a satisfies-typed fixture", () => {
    for (const state of PROCESS_STATES) {
      const running = state === "running" || state === "starting" || state === "stopping";
      const fixture = {
        state,
        pid: running ? 4821 : null,
        startedAtMs: running ? 1_800_000_000_000 : null,
        version: "0.1.0",
      } satisfies ProcessInfo;
      expect(validate(fixture), `${state}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects a state outside the closed enum", () => {
    expect(validate({ state: "paused", pid: null, startedAtMs: null, version: "0.1.0" })).toBe(
      false,
    );
  });

  it("rejects an empty version string", () => {
    expect(validate({ state: "stopped", pid: null, startedAtMs: null, version: "" })).toBe(false);
  });

  it("rejects a missing pid field (must be present, even as null)", () => {
    expect(validate({ state: "stopped", startedAtMs: null, version: "0.1.0" })).toBe(false);
  });
});
