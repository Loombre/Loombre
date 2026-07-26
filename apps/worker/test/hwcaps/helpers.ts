// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/hwcaps/helpers.ts
//
// Shared fake CommandRunner / ProbeFileFn test doubles — every hwcaps unit
// test uses these instead of the real spawn/ffprobe wiring (binding
// constraint 1: unit tests never invoke real ffmpeg).

import type { CommandResult, CommandRunner, ProbeFileFn, ProbedFileInfo, RunCommandOptions } from "../../src/hwcaps/types.js";

export interface FakeRunnerCall {
  bin: string;
  args: string[];
  options: RunCommandOptions;
}

export type FakeRunnerHandler = (call: FakeRunnerCall) => CommandResult | Promise<CommandResult>;

export interface FakeRunner extends CommandRunner {
  calls: FakeRunnerCall[];
}

export function okResult(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0, timedOut: false };
}

export function failResult(exitCode = 1, stderr = ""): CommandResult {
  return { stdout: "", stderr, exitCode, timedOut: false };
}

export function timeoutResult(stderr = ""): CommandResult {
  return { stdout: "", stderr, exitCode: null, timedOut: true };
}

/** A fake runner driven by a handler function — call it with whatever
 *  branching logic a test needs (keyed on `bin`/`args`), and it records
 *  every call for later assertions (e.g. "software was tested before any
 *  hardware backend", "exactly N ffmpeg invocations happened"). */
export function createFakeRunner(handler: FakeRunnerHandler): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  return {
    calls,
    async run(bin, args, options) {
      const call = { bin, args, options };
      calls.push(call);
      return handler(call);
    },
  };
}

/** A fake ProbeFileFn driven by a handler keyed on the file path — the
 *  battery re-probes encode/tone-map test OUTPUT paths, so tests key their
 *  fake responses on the path the battery itself constructs (which is
 *  deterministic given `workDir`). */
export function createFakeProbeFile(handler: (filePath: string) => ProbedFileInfo | null): ProbeFileFn {
  return async (filePath: string) => handler(filePath);
}

/** A deterministic manual clock — avoids real Date.now() jitter in report
 *  structure assertions. */
export function fakeClock(startMs = 1_700_000_000_000): () => number {
  let now = startMs;
  return () => {
    now += 1;
    return now;
  };
}
