// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/test/type-agreement.spec.ts — see
// packages/provisioning/test/type-agreement.spec.ts for the full rationale
// (expectTypeOf for bidirectional type equality + @ts-expect-error to
// prove the closed types actually reject out-of-enum literals; both only
// enforced because tsconfig.test.json chains into `pnpm typecheck`).

import { describe, expect, it, expectTypeOf } from "vitest";

import { PROCESS_STATES, PROCESS_INFO_SCHEMA, type ProcessState } from "../src/process-info.js";
import { IPC_ERROR_CODES, IPC_ERROR_BODY_SCHEMA, type IpcErrorCode, type IpcErrorBody } from "../src/error-body.js";

describe("closed-enum agreement: TS union types vs runtime arrays", () => {
  it("ProcessState === (typeof PROCESS_STATES)[number]", () => {
    expectTypeOf<(typeof PROCESS_STATES)[number]>().toEqualTypeOf<ProcessState>();
  });

  it("IpcErrorCode === (typeof IPC_ERROR_CODES)[number]", () => {
    expectTypeOf<(typeof IPC_ERROR_CODES)[number]>().toEqualTypeOf<IpcErrorCode>();
  });
});

describe("closed-enum agreement: runtime arrays vs the schemas' own enum fields", () => {
  it("PROCESS_INFO_SCHEMA.properties.state.enum === PROCESS_STATES", () => {
    expect(PROCESS_INFO_SCHEMA.properties.state.enum).toEqual(PROCESS_STATES);
  });

  it("IPC_ERROR_BODY_SCHEMA.properties.code.enum === IPC_ERROR_CODES", () => {
    expect(IPC_ERROR_BODY_SCHEMA.properties.code.enum).toEqual(IPC_ERROR_CODES);
  });
});

describe("closed-enum agreement: TS rejects out-of-enum literals (compile-time)", () => {
  it("ProcessState rejects a non-member string literal", () => {
    // @ts-expect-error 'booting' is not a member of ProcessState. If this
    // stops erroring, ProcessState/PROCESS_STATES and PROCESS_INFO_SCHEMA's
    // enum have silently diverged.
    const bad: ProcessState = "booting";
    void bad;
    expect(true).toBe(true);
  });

  it("IpcErrorBody.code rejects a non-member string literal", () => {
    // @ts-expect-error 'boom' is not a member of IpcErrorCode.
    void ({ title: "x", status: 500, code: "boom" } satisfies IpcErrorBody);
    expect(true).toBe(true);
  });
});
