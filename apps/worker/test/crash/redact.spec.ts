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

  // V1-003: the connection-string pass split on the FIRST "@", so a password
  // containing "@" leaked its tail past the mask into the crash file. WHATWG
  // authority parsing splits on the LAST "@" (verified against pg's own
  // connection-string parser and the URL constructor); fix must match.
  // apps/server/test/crash/redact.spec.ts carries the identical block — this
  // file's own header documents it as an intentional near-identical twin.
  describe("password containing @ (V1-003)", () => {
    it("redacts a password containing exactly one @, leaking no fragment of it", () => {
      const text = "failed to connect: postgres://loombre:p@ssword@localhost:5442/loombre";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("ssword");
      expect(redacted).not.toContain("p@ssword");
      expect(redacted).toBe("failed to connect: postgres://loombre:<redacted>@localhost:5442/loombre");
    });

    it("redacts a password containing multiple @ characters, leaking no fragment of it", () => {
      const text = "failed to connect: postgres://loombre:p@ss@word@localhost:5442/loombre";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("word");
      expect(redacted).not.toContain("p@ss");
      expect(redacted).toBe("failed to connect: postgres://loombre:<redacted>@localhost:5442/loombre");
    });

    it("redacts a password ending in a trailing @, leaking no fragment of it", () => {
      const text = "failed to connect: postgres://loombre:secret@@localhost:5442/loombre";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("secret");
      expect(redacted).toBe("failed to connect: postgres://loombre:<redacted>@localhost:5442/loombre");
    });

    it("redacts the password even when the username also contains an @", () => {
      const text = "failed to connect: postgres://user@example.com:pass@localhost:5442/loombre";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pass@localhost");
      expect(redacted).toBe("failed to connect: postgres://user@example.com:<redacted>@localhost:5442/loombre");
    });

    it("does not regress a connection string with no credentials at all", () => {
      const text = "failed to connect: postgres://localhost:5442/loombre";
      expect(redactSecretShapedValues(text)).toBe(text);
    });
  });

  // FW3-C REGRESSION: the connection-string token-finder used
  // `/\w+:\/\/[^\s/]*@[^\s/]*/g`, whose greedy `[^\s/]*` "host" half only
  // stops at whitespace or "/". A realistic connection-failure message
  // often names TWO connection strings on one line (DATABASE_URL and
  // REDIS_URL both surfacing in one error); when they're separated by
  // something that is neither whitespace nor "/" (a comma, a semicolon, a
  // JSON quote), the first match's greedy tail swallows the second
  // scheme://user:pass@host whole, the `/g` scan resumes past it, and its
  // password is never redacted at all.
  // apps/server/test/crash/redact.spec.ts carries the identical block — this
  // file's own header documents it as an intentional near-identical twin.
  describe("two connection strings on one line (FW3-C regression)", () => {
    it("redacts both passwords when the strings are comma-separated", () => {
      const text = "DATABASE_URL=postgres://u:pw1@db,REDIS_URL=redis://u:pw2@rd";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw1");
      expect(redacted).not.toContain("pw2");
      expect(redacted).toBe("DATABASE_URL=postgres://u:<redacted>@db,REDIS_URL=redis://u:<redacted>@rd");
    });

    it("redacts both passwords when the strings are semicolon-separated", () => {
      const text = "postgres://u:pw1@db;redis://u:pw2@rd";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw1");
      expect(redacted).not.toContain("pw2");
      expect(redacted).toBe("postgres://u:<redacted>@db;redis://u:<redacted>@rd");
    });

    it("redacts both passwords when the strings are inside a JSON object", () => {
      const text = '{"a":"postgres://u1:p1@h1","b":"redis://u2:p2@h2"}';
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("p1");
      expect(redacted).not.toContain("p2");
      expect(redacted).toBe('{"a":"postgres://u1:<redacted>@h1","b":"redis://u2:<redacted>@h2"}');
    });

    // R5: the FW3-C fix above still enumerated forbidden separators for the
    // HOST half of the token (a denylist), so it only stopped at the
    // specific punctuation it happened to list. "&", "|", and "<"/">" were
    // never added to that list, so the same over-consumption bug — verified
    // by execution — still swallows a second connection string whole and
    // its password never gets redacted. This is the third consecutive wave
    // to leave this rule denylist-shaped; see the allowlist fix below.
    // apps/server/test/crash/redact.spec.ts carries the identical block —
    // this file's own header documents it as an intentional near-identical
    // twin.
    it("redacts both passwords when the strings are ampersand-separated", () => {
      const text = "postgres://u:pw1@db&redis://u:pw2@rd";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw1");
      expect(redacted).not.toContain("pw2");
      expect(redacted).toBe("postgres://u:<redacted>@db&redis://u:<redacted>@rd");
    });

    it("redacts both passwords when the strings are pipe-separated", () => {
      const text = "postgres://u:pw1@db|redis://u:pw2@rd";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw1");
      expect(redacted).not.toContain("pw2");
      expect(redacted).toBe("postgres://u:<redacted>@db|redis://u:<redacted>@rd");
    });

    it("redacts both passwords when the strings are angle-bracket-wrapped", () => {
      const text = "<postgres://u:pw1@db><redis://u:pw2@rd>";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw1");
      expect(redacted).not.toContain("pw2");
      expect(redacted).toBe("<postgres://u:<redacted>@db><redis://u:<redacted>@rd>");
    });
  });

  // R5: the denylist above also cut the other way — a password containing
  // one of the very characters it excluded (",", ";", '"', "'", "`", "(",
  // ")", "[", "]", "{", "}") broke the match ENTIRELY (the userinfo half
  // couldn't reach the required "@"), so the whole token was left
  // untouched and the password leaked in full, unredacted. Once the HOST
  // half is an allowlist of what's actually legal in a host (RFC 3986
  // reg-name + IPv6-literal brackets + port colon), the host boundary
  // itself stops the match — the userinfo/password half no longer needs to
  // enumerate forbidden separators at all, so this coverage can be
  // restored.
  // apps/server/test/crash/redact.spec.ts carries the identical block —
  // this file's own header documents it as an intentional near-identical
  // twin.
  describe("password content the host allowlist now safely permits", () => {
    it("redacts a password containing comma, semicolon, quotes, backtick, parens, brackets, and braces, leaking no fragment of it", () => {
      const text = "failed to connect: postgres://u:p,w;1\"2'3`4(5)6[7]8{9}@host/db";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("p,w;1");
      expect(redacted).not.toContain("{9}");
      expect(redacted).toBe("failed to connect: postgres://u:<redacted>@host/db");
    });

    it("still finds the host boundary when a comma is BOTH inside a password AND the separator between two connection strings", () => {
      const text = "postgres://u:pw,1@db,redis://u:pw,2@rd";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("pw,1");
      expect(redacted).not.toContain("pw,2");
      expect(redacted).toBe("postgres://u:<redacted>@db,redis://u:<redacted>@rd");
    });
  });

  // F1 LOOKAHEAD FIX: "[" and "]" are IN the host allowlist (needed for
  // IPv6 literals), so two credentialed URLs glued by only host-legal
  // characters — brackets, "::", ".", or nothing at all — over-consumed
  // past the real host boundary under the plain allowlist regex, and the
  // SECOND password survived in full. A negative lookahead
  // (`(?!\w+:\/\/)`) interleaved into the host character class stops the
  // run at a following scheme, which is the structural property the
  // allowlist alone could not provide.
  // apps/server/test/crash/redact.spec.ts carries the identical block —
  // this file's own header documents it as an intentional near-identical
  // twin.
  describe("host-legal-character adjacency between two connection strings (F1 regression)", () => {
    it("redacts both passwords when the strings are bracket-adjacent with no other separator", () => {
      const text = "[postgres://u1:P1@h1][postgres://u2:P2@h2]";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("P1");
      expect(redacted).not.toContain("P2");
      expect(redacted).toBe("[postgres://u1:<redacted>@h1][postgres://u2:<redacted>@h2]");
    });

    it("redacts both passwords when the strings are glued by an all-host-legal separator (a dot)", () => {
      const text = "postgres://u1:P1@h1.postgres://u2:P2@h2";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("P1");
      expect(redacted).not.toContain("P2");
      expect(redacted).toBe("postgres://u1:<redacted>@h1.postgres://u2:<redacted>@h2");
    });

    it("redacts both passwords when the strings are glued by an all-host-legal separator (a double colon)", () => {
      const text = "postgres://u1:P1@h1::postgres://u2:P2@h2";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("P1");
      expect(redacted).not.toContain("P2");
      expect(redacted).toBe("postgres://u1:<redacted>@h1::postgres://u2:<redacted>@h2");
    });

    it("redacts both passwords when the strings have no separator at all", () => {
      const text = "postgres://u1:P1@h1postgres://u2:P2@h2";
      const redacted = redactSecretShapedValues(text);
      expect(redacted).not.toContain("P1");
      expect(redacted).not.toContain("P2");
      expect(redacted).toBe("postgres://u1:<redacted>@h1postgres://u2:<redacted>@h2");
    });
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
