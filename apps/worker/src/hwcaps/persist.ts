// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Maps a `ProbeReport` (types.ts) into the `@loombre/db/internal` writer's
 * input shape and calls it — the only file in apps/worker/src/hwcaps that
 * imports @loombre/db/internal (P1.13's fence: apps/worker is one of the
 * allowed importers).
 */
import { recordVerifiedCapabilitiesSnapshot } from "@loombre/db/internal";
import type { HwPlatform } from "@loombre/db";
import { toVerifiedCapabilities } from "./report.js";
import { validateVerifiedCapabilities } from "./schema.js";
import type { ProbeReport } from "./types.js";

const KNOWN_PLATFORMS: readonly HwPlatform[] = ["darwin", "linux", "win32"];

/** docs/PLAYBACK.md §8.2 only gives a candidate order for these three
 *  platforms — migrations/0011's CHECK constraint matches. Any other
 *  `os.platform()` value (freebsd, aix, sunos, ...) is a real, if unlikely,
 *  edge this function refuses to silently miscode into the DB; the caller
 *  (run.ts) surfaces this as a clean thrown error rather than a CHECK
 *  constraint violation deep in a transaction. */
export function assertHwPlatform(platform: NodeJS.Platform): HwPlatform {
  if ((KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
    return platform as HwPlatform;
  }
  throw new Error(
    `apps/worker/src/hwcaps: platform "${platform}" has no docs/PLAYBACK.md §8.2 candidate order (known: ${KNOWN_PLATFORMS.join(", ")}) — cannot persist a hw_capability_snapshots row for it.`
  );
}

/**
 * Persists `report` as the new current snapshot for its platform (the
 * internal writer flips the prior current row false in the same
 * transaction — see packages/db/src/internal/hwcaps.ts).
 */
/** Backend row shape once every field has been runtime-validated against
 *  schema.ts's closed §2.5 value sets — the only honest justification for
 *  the type assertion this function's single call site performs (never a
 *  bare "trust me" cast on unvalidated data). */
type ValidatedBackendInput = Parameters<typeof recordVerifiedCapabilitiesSnapshot>[1]["backends"][number];

export async function persistProbeReport(
  db: Parameters<typeof recordVerifiedCapabilitiesSnapshot>[0],
  report: ProbeReport
): Promise<void> {
  const platform = assertHwPlatform(report.platform);
  const verified = toVerifiedCapabilities({ backends: report.backends });

  // Defense in depth: never write a snapshot this module's own shared
  // schema validator (binding constraint 6) wouldn't also accept — the
  // exact validator test/hwcaps/conformance.spec.ts runs the caps.yaml
  // fixtures through.
  const validation = validateVerifiedCapabilities(verified);
  if (!validation.valid) {
    throw new Error(
      `apps/worker/src/hwcaps/persist.ts: probe-produced VerifiedCapabilities failed schema validation, refusing to persist: ${JSON.stringify(validation.violations)}`
    );
  }

  await recordVerifiedCapabilitiesSnapshot(db, {
    platform,
    ffmpegBuildHash: report.ffmpegBuildHash,
    gpuFingerprint: report.gpuFingerprint,
    verifiedAtMs: report.generatedAtMs,
    backends: report.backends.map((backendReport, i): ValidatedBackendInput => {
      const verifiedBackend = verified.backends[i]!;
      // Safe: `validation.valid` above already proved every field of
      // `verified` (which these three arrays + backend string come from)
      // is a member of its closed §2.5 set.
      return {
        position: i,
        backend: verifiedBackend.backend,
        decode: verifiedBackend.decode,
        encode: verifiedBackend.encode,
        toneMap: verifiedBackend.toneMap,
        verifiedAtMs: backendReport.verifiedAtMs,
      } as ValidatedBackendInput;
    }),
  });
}
