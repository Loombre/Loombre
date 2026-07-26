// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/dns01-hook.spec.ts
//
// runDnsHook: a REAL child process (a small script fixture), not a mock —
// proves the seam a real operator-authored hook script would see: argv
// shape, env vars, exit-code handling, stderr surfacing on failure,
// timeout enforcement. pollTxtRecordVisible is tested against a real
// (but tiny, local) DNS server so this suite has zero network dependency
// beyond loopback — the pebble suite is what proves it against a REAL
// ACME-facing resolver end-to-end.

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dgram from "node:dgram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatManualDnsInstructions, pollTxtRecordVisible, runDnsHook } from "./dns01-hook.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loombre-dns-hook-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

// WINDOWS: the script-fixture cases below are POSIX-only, and that reflects
// a real product limitation rather than a test shortcut. runDnsHook spawns
// the operator's hook path DIRECTLY (no shell — deliberately, since the
// hook receives attacker-influenceable record values). On Windows that
// means:
//   * a `#!/bin/sh` script cannot be executed at all (spawn EFTYPE — what
//     the first windows-latest CI run hit), and
//   * `.cmd`/`.bat` cannot be spawned without `shell: true`, which Node
//     has refused since the CVE-2024-27980 batch-file fix.
// So today a Windows operator's LOOMBRE_ACME_DNS_HOOK must be a native
// executable; no script fixture can stand in for one here. Enabling
// `.cmd` hooks would mean reintroducing a shell into this spawn, which is
// a security decision for the owner, not a test fix — logged in STATE.md.
// The spawn-failure case below is NOT gated: it must hold everywhere.
const POSIX_ONLY_SCRIPT_HOOKS = process.platform !== "win32";

describe("runDnsHook", () => {
  it.runIf(POSIX_ONLY_SCRIPT_HOOKS)("resolves when the script exits 0, passing action/record/value as argv", async () => {
    const outPath = join(dir, "out.json");
    const script = writeScript(
      "hook.sh",
      `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > "${outPath}"\nexit 0\n`,
    );
    await expect(runDnsHook(script, "set", "_acme-challenge.example.com", "the-txt-value")).resolves.toBeUndefined();

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outPath, "utf8")).toBe("set|_acme-challenge.example.com|the-txt-value");
  });

  it.runIf(POSIX_ONLY_SCRIPT_HOOKS)("also exposes action/record/value via env vars", async () => {
    const outPath = join(dir, "env-out.txt");
    const script = writeScript(
      "hook-env.sh",
      `#!/bin/sh\nprintf '%s|%s|%s' "$LOOMBRE_ACME_DNS_ACTION" "$LOOMBRE_ACME_DNS_RECORD" "$LOOMBRE_ACME_DNS_VALUE" > "${outPath}"\n`,
    );
    await runDnsHook(script, "clear", "_acme-challenge.example.com", "value-2");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outPath, "utf8")).toBe("clear|_acme-challenge.example.com|value-2");
  });

  it.runIf(POSIX_ONLY_SCRIPT_HOOKS)("rejects with stderr content when the script exits nonzero", async () => {
    const script = writeScript("fail.sh", `#!/bin/sh\necho "provider API rejected the record" 1>&2\nexit 1\n`);
    await expect(runDnsHook(script, "set", "_acme-challenge.example.com", "v")).rejects.toThrow(
      /provider API rejected the record/,
    );
  });

  it("rejects when the script does not exist", async () => {
    await expect(runDnsHook(join(dir, "nope.sh"), "set", "r", "v")).rejects.toThrow();
  });

  it.runIf(POSIX_ONLY_SCRIPT_HOOKS)("rejects on timeout and kills the hung process", async () => {
    const script = writeScript("hang.sh", `#!/bin/sh\nsleep 30\n`);
    await expect(runDnsHook(script, "set", "r", "v", { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});

describe("pollTxtRecordVisible", () => {
  it("returns false on timeout when the record never appears (real DNS resolution against loopback, nothing listening)", async () => {
    // Point the resolver at a closed local UDP port — every query gets a
    // real connection-refused/timeout condition, never a fabricated one.
    const seen = await pollTxtRecordVisible("_acme-challenge.example.invalid", "value", {
      resolverAddresses: ["127.0.0.1:19999"],
      timeoutMs: 300,
      intervalMs: 50,
    });
    expect(seen).toBe(false);
  });

  it("returns true once a real (tiny, local) DNS server starts answering with the expected TXT value", async () => {
    const recordName = "_acme-challenge.loombre-dns-hook-test.invalid";
    const expectedValue = "the-real-value";

    // A minimal real DNS server: SERVFAIL until `armed` flips, then a
    // hand-built TXT answer. This is a real UDP DNS wire-protocol
    // responder (parses the incoming query's ID + question, builds a
    // real answer section) — not a stub of pollTxtRecordVisible itself.
    let armed = false;
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
      const id = msg.subarray(0, 2);
      const question = msg.subarray(12);
      if (!armed) {
        const header = Buffer.from([id[0]!, id[1]!, 0x81, 0x82, 0, 1, 0, 0, 0, 0, 0, 0]);
        socket.send(Buffer.concat([header, question]), rinfo.port, rinfo.address);
        return;
      }
      const answerName = Buffer.from([0xc0, 0x0c]); // pointer to the question's name
      const txt = Buffer.from(expectedValue, "utf8");
      const rdata = Buffer.concat([Buffer.from([txt.length]), txt]);
      const answer = Buffer.concat([
        answerName,
        Buffer.from([0x00, 0x10]), // TYPE=TXT
        Buffer.from([0x00, 0x01]), // CLASS=IN
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // TTL=1
        Buffer.from([(rdata.length >> 8) & 0xff, rdata.length & 0xff]),
        rdata,
      ]);
      const header = Buffer.from([id[0]!, id[1]!, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
      socket.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });

    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const address = socket.address();

    setTimeout(() => {
      armed = true;
    }, 150);

    try {
      const seen = await pollTxtRecordVisible(recordName, expectedValue, {
        resolverAddresses: [`127.0.0.1:${address.port}`],
        timeoutMs: 3000,
        intervalMs: 50,
      });
      expect(seen).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe("formatManualDnsInstructions", () => {
  it("includes the record name and value", () => {
    const msg = formatManualDnsInstructions("_acme-challenge.example.com", "abc123");
    expect(msg).toContain("_acme-challenge.example.com");
    expect(msg).toContain("abc123");
    expect(msg).toContain("LOOMBRE_ACME_DNS_HOOK");
  });
});
