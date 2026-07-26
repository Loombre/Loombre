// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/crash/redact.spec.ts
//
// Fixture stacks built from REAL Node.js stack-trace shapes (parenthesized
// frames, bare frames, fs error messages) seeded with fake secrets/paths —
// task spec: "redaction unit-tested against fixture stacks containing fake
// secrets/paths".

import { describe, expect, it } from "vitest";
import { redactFreeText, redactPaths, redactSecretShapedValues } from "../../src/crash/redact.js";

const DATA_DIR = "/Users/fakeuser/Library/Application Support/Loombre";

describe("redactPaths", () => {
  it("leaves paths INSIDE the app-data dir untouched", () => {
    const text = `at Object.<anonymous> (${DATA_DIR}/postgres/data/base/16384/2610:1:1)`;
    expect(redactPaths(text, DATA_DIR)).toBe(text);
  });

  it("redacts a parenthesized stack-frame path outside the app-data dir to <redacted>/basename, preserving line:col", () => {
    const text = "at Object.<anonymous> (/Users/fakeuser/App Development/Loombre/apps/server/dist/main.js:42:17)";
    expect(redactPaths(text, DATA_DIR)).toBe("at Object.<anonymous> (<redacted>/main.js:42:17)");
  });

  it("redacts a bare (no-parens) stack frame with an embedded space in the path", () => {
    const text = "at /Users/fakeuser/App Development/Loombre/apps/worker/dist/index.js:7:3";
    expect(redactPaths(text, DATA_DIR)).toBe("at <redacted>/index.js:7:3");
  });

  it("redacts a full multi-line stack trace, mixing inside- and outside-dataDir frames", () => {
    const stack = [
      "Error: ENOENT: no such file or directory",
      "    at Object.openSync (node:fs:585:3)",
      `    at Object.func (${DATA_DIR}/postgres/superuser.secret:1:1)`,
      "    at Object.other (/Users/fakeuser/.ssh/id_rsa:1:1)",
      "    at /Users/fakeuser/App Development/Loombre/apps/server/src/crash/handlers.ts:99:5",
    ].join("\n");

    const redacted = redactPaths(stack, DATA_DIR);
    expect(redacted).toContain(`${DATA_DIR}/postgres/superuser.secret:1:1`); // inside dataDir, kept verbatim
    expect(redacted).toContain("<redacted>/id_rsa:1:1"); // outside dataDir, collapsed
    expect(redacted).toContain("<redacted>/handlers.ts:99:5"); // outside dataDir, embedded space, collapsed
    expect(redacted).not.toContain("/Users/fakeuser/.ssh"); // the outside-dataDir directory structure never survives
    expect(redacted).not.toContain("App Development"); // ditto for the other outside-dataDir line
  });

  it("redacts a quoted absolute path inside a plain error message", () => {
    const text = "ENOENT: no such file or directory, open '/Users/fakeuser/.env'";
    expect(redactPaths(text, DATA_DIR)).toBe("ENOENT: no such file or directory, open '<redacted>/.env'");
  });

  it("redacts a bare unquoted absolute path with no spaces", () => {
    const text = "cannot read /etc/loombre/secrets.json";
    expect(redactPaths(text, DATA_DIR)).toBe("cannot read <redacted>/secrets.json");
  });

  it("redacts a percent-encoded file:// URL (ESM import-error shape), decoding %20 back to a space for the inside/outside comparison", () => {
    const text = "Cannot find package 'foo' imported from file:///Users/fakeuser/App%20Development/Loombre/apps/server/dist/main.js";
    expect(redactPaths(text, DATA_DIR)).toBe("Cannot find package 'foo' imported from <redacted>/main.js");
  });

  it("keeps a file:// URL that decodes to a path INSIDE the app-data dir", () => {
    const encoded = DATA_DIR.replace(/ /g, "%20");
    const text = `imported from file://${encoded}/postgres/data/x.js`;
    expect(redactPaths(text, DATA_DIR)).toBe(text);
  });

  it("redacts a Windows-style absolute path", () => {
    const text = "at Object.<anonymous> (C:\\Users\\fakeuser\\loombre\\dist\\main.js:1:1)";
    expect(redactPaths(text, DATA_DIR)).toBe("at Object.<anonymous> (<redacted>/main.js:1:1)");
  });

  it("does not mangle text with no paths at all", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'foo')";
    expect(redactPaths(text, DATA_DIR)).toBe(text);
  });

  it("empty dataDir never matches 'inside' (never silently exempts everything)", () => {
    const text = "/Users/fakeuser/secret.txt";
    expect(redactPaths(text, "")).toBe("<redacted>/secret.txt");
  });
});

describe("redactSecretShapedValues", () => {
  it("redacts a Bearer token", () => {
    const text = "request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.super-fake-payload.super-fake-signature";
    const redacted = redactSecretShapedValues(text);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).toContain("Bearer <redacted>");
  });

  it("redacts a JWT-shaped three-segment token even without a Bearer prefix", () => {
    const text = "token was eyJhbGciOiJIUzI1NiJ9.fakepayloadfakepayload.fakesignaturefakesignature and it expired";
    const redacted = redactSecretShapedValues(text);
    expect(redacted).not.toContain("fakepayloadfakepayload");
    expect(redacted).toContain("<redacted>");
  });

  it("redacts key=value pairs for token/password/secret/api-key", () => {
    const cases = [
      ["LOOMBRE_JWT_SECRET=super-secret-value-123", "super-secret-value-123"],
      ["password: hunter2hunter2", "hunter2hunter2"],
      ["apiKey=tmdb-fake-key-abc123", "tmdb-fake-key-abc123"],
      ["api-key=fake-abc123", "fake-abc123"],
    ];
    for (const [input, secretValue] of cases) {
      const redacted = redactSecretShapedValues(input!);
      expect(redacted, `input: ${input}`).not.toContain(secretValue);
      expect(redacted, `input: ${input}`).toContain("<redacted>");
    }
  });

  it("does not touch ordinary prose with no secret-shaped substrings", () => {
    const text = "connection refused at 127.0.0.1:5433";
    expect(redactSecretShapedValues(text)).toBe(text);
  });

  it("redacts the password segment of a connection string, keeping user/host/port", () => {
    const text = "failed to connect: postgres://loombre:CorrectHorseBatteryStaple@localhost:5433/loombre";
    const redacted = redactSecretShapedValues(text);
    expect(redacted).not.toContain("CorrectHorseBatteryStaple");
    expect(redacted).toBe("failed to connect: postgres://loombre:<redacted>@localhost:5433/loombre");
  });
});

describe("redactFreeText (combined pass, the one crash reports actually use)", () => {
  it("redacts both a path AND a secret in the same fixture stack", () => {
    const stack = [
      "Error: failed to connect: postgres://loombre:CorrectHorseBatteryStaple@localhost:5433/loombre",
      `    at Object.connect (/Users/fakeuser/App Development/Loombre/packages/db/dist/db.js:12:3)`,
      "    at fetchWithToken (/Users/fakeuser/App Development/Loombre/apps/web/src/lib/sdk-client.ts:8:1)",
      "    -- caused by: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.realpayloadrealpayload.realsignaturerealsig",
    ].join("\n");

    const redacted = redactFreeText(stack, DATA_DIR);
    expect(redacted).not.toContain("fakeuser");
    expect(redacted).not.toContain("App Development");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9.realpayloadrealpayload");
    expect(redacted).not.toContain("CorrectHorseBatteryStaple");
    expect(redacted).toContain("<redacted>/db.js:12:3");
    expect(redacted).toContain("<redacted>/sdk-client.ts:8:1");
  });
});
