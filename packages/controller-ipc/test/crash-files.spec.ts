// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  CRASH_FILES_REQUEST_SCHEMA,
  CRASH_FILES_RESPONSE_SCHEMA,
  type CrashFilesRequest,
  type CrashFilesResponse,
} from "../src/index.js";

describe("crash-files", () => {
  it("request schema accepts only an empty object", () => {
    const validate = compile(CRASH_FILES_REQUEST_SCHEMA);
    const empty = {} satisfies CrashFilesRequest;
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
  });

  it("response schema accepts an empty list and a populated list", () => {
    const validate = compile(CRASH_FILES_RESPONSE_SCHEMA);
    expect(
      validate({ files: [] } satisfies CrashFilesResponse),
      JSON.stringify(validate.errors),
    ).toBe(true);

    const fixture = {
      files: [
        { path: "/var/lib/loombre/crashes/server-2026-07-24T00-00-00.log", mtimeMs: 1_800_000_000_000 },
        { path: "/var/lib/loombre/crashes/worker-2026-07-23T00-00-00.log", mtimeMs: 1_799_900_000_000 },
      ],
    } satisfies CrashFilesResponse;
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("response schema rejects an entry missing mtimeMs", () => {
    const validate = compile(CRASH_FILES_RESPONSE_SCHEMA);
    expect(validate({ files: [{ path: "/x" }] })).toBe(false);
  });

  it("response schema rejects a negative mtimeMs", () => {
    const validate = compile(CRASH_FILES_RESPONSE_SCHEMA);
    expect(validate({ files: [{ path: "/x", mtimeMs: -1 }] })).toBe(false);
  });
});
