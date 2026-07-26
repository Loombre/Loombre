// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/crash-dir.test.ts
//
// crashDirPath is a NATIVE-path helper (node:path join), so its output is
// platform-correct by design: backslashes on Windows, forward slashes on
// POSIX. These assertions therefore compare against join()-built
// expectations rather than hardcoded "/var/lib/loombre/crashes" literals —
// the literal form passed on ubuntu/macOS and failed the first
// windows-latest CI execution ('\var\lib\loombre\crashes'), which was a bug
// in the TEST, not in the helper (a Windows install must get Windows
// separators — this is a real filesystem path both apps write to).

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { crashDirPath } from "../src/crash-dir.js";

const DATA_DIR = join("/var", "lib", "loombre");
const EXPECTED = join("/var", "lib", "loombre", "crashes");

describe("crashDirPath", () => {
  it("appends 'crashes' to the given data directory", () => {
    expect(crashDirPath(DATA_DIR)).toBe(EXPECTED);
  });

  it("is the single source of truth both apps' crash modules and the IPC listener import — pure, no trailing-slash surprises", () => {
    expect(crashDirPath(`${DATA_DIR}/`)).toBe(EXPECTED);
  });

  it("returns a NATIVE path — separators follow the host platform, never a hardcoded POSIX literal", () => {
    const result = crashDirPath(DATA_DIR);
    expect(result.endsWith(join("loombre", "crashes"))).toBe(true);
    if (process.platform === "win32") {
      expect(result).toContain("\\");
    } else {
      expect(result).not.toContain("\\");
    }
  });
});
