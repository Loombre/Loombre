// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  OPEN_WEB_TARGET_REQUEST_SCHEMA,
  OPEN_WEB_TARGET_RESPONSE_SCHEMA,
  type OpenWebTargetRequest,
  type OpenWebTargetResponse,
} from "../src/index.js";

describe("open-web-target", () => {
  it("request schema accepts only an empty object", () => {
    const validate = compile(OPEN_WEB_TARGET_REQUEST_SCHEMA);
    const empty = {} satisfies OpenWebTargetRequest;
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
  });

  it("response schema accepts a well-formed url", () => {
    const validate = compile(OPEN_WEB_TARGET_RESPONSE_SCHEMA);
    const fixture = { url: "http://127.0.0.1:8080" } satisfies OpenWebTargetResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("response schema rejects an empty url", () => {
    const validate = compile(OPEN_WEB_TARGET_RESPONSE_SCHEMA);
    expect(validate({ url: "" })).toBe(false);
  });

  it("response schema rejects a missing url", () => {
    const validate = compile(OPEN_WEB_TARGET_RESPONSE_SCHEMA);
    expect(validate({})).toBe(false);
  });
});
