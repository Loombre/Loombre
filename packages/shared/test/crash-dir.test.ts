// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { crashDirPath } from "../src/crash-dir.js";

describe("crashDirPath", () => {
  it("appends 'crashes' to the given data directory", () => {
    expect(crashDirPath("/var/lib/loombre")).toBe("/var/lib/loombre/crashes");
  });

  it("is the single source of truth both apps' crash modules and the IPC listener import — pure, no trailing-slash surprises", () => {
    expect(crashDirPath("/var/lib/loombre/")).toBe("/var/lib/loombre/crashes");
  });
});
