// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/hwcaps — public module barrel.
//
// Hardware capability self-test probe (docs/PLAYBACK.md §8, Phase 3 §11
// step 5): battery orchestration (battery.ts, injected CommandRunner),
// real spawn/fingerprint/persistence wiring, and the shared §2.5 schema
// validator every fixture set AND real probe output is checked against
// (schema.ts / test/hwcaps/conformance.spec.ts).

export type {
  BackendReport,
  CommandResult,
  CommandRunner,
  HwBackend,
  ProbeEncodeCodec,
  ProbedFileInfo,
  ProbeFileFn,
  ProbeReport,
  ProbeToneMapMethod,
  ProbeVideoCodec,
  RunCommandOptions,
  TestOutcome,
  TestResult,
  TestableToneMapMethod,
} from "./types.js";
export { DECODE_TEST_CODECS, ENCODE_TEST_CODECS } from "./types.js";

export { candidatesForPlatform } from "./platforms.js";
export type { BatteryDeps, BatteryResult } from "./battery.js";
export { runProbeBattery } from "./battery.js";
export { createRealCommandRunner } from "./command-runner.js";
export { probeFileReal } from "./probe-file.js";
export { computeFfmpegBuildHash, computeGpuFingerprint } from "./fingerprint.js";
export type { CurrentSnapshotFingerprint, InvalidationReason, ResolvedFingerprint } from "./invalidation.js";
export { decideInvalidation } from "./invalidation.js";
export type { VerifiedCapabilitiesBackendLike, VerifiedCapabilitiesLike } from "./report.js";
export { formatProbeReport, toVerifiedCapabilities } from "./report.js";
export type { SchemaViolation, ValidationResult } from "./schema.js";
export { validateVerifiedCapabilities } from "./schema.js";
export type { CapsBackendFixture, CapsFixtureSet, CapsFixtures } from "./caps-yaml.js";
export { parseCapsYaml } from "./caps-yaml.js";
export type { CurrentFingerprint } from "./run.js";
export { computeCurrentFingerprint, runRealHwProbeBattery } from "./run.js";
export { assertHwPlatform, persistProbeReport } from "./persist.js";
