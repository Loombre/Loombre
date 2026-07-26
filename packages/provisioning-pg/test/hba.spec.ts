// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { PG_HBA_CONTENTS } from "../src/hba.js";

describe("PG_HBA_CONTENTS", () => {
  it("restricts every entry to local or loopback, all scram-sha-256", () => {
    const dataLines = PG_HBA_CONTENTS.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines) {
      expect(line).toMatch(/scram-sha-256\s*$/);
      const isLocal = line.startsWith("local");
      const isLoopbackV4 = line.includes("127.0.0.1/32");
      const isLoopbackV6 = line.includes("::1/128");
      expect(isLocal || isLoopbackV4 || isLoopbackV6).toBe(true);
    }
  });

  function dataLines(): string[] {
    return PG_HBA_CONTENTS.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  }

  it("never contains `trust` as an auth method (data lines only — the header comment discusses its absence in prose)", () => {
    for (const line of dataLines()) expect(line).not.toMatch(/\btrust\b/);
  });

  it("carries no replication entries (data lines only)", () => {
    for (const line of dataLines()) expect(line).not.toMatch(/\breplication\b/);
  });

  it("never grants access from a non-loopback address", () => {
    // Any bare "host ... all ..." line whose address column isn't a
    // loopback literal would be a real localhost-only regression.
    const hostLines = PG_HBA_CONTENTS.split("\n").filter((l) => l.trim().startsWith("host"));
    for (const line of hostLines) {
      expect(/127\.0\.0\.1\/32|::1\/128/.test(line)).toBe(true);
    }
  });
});
