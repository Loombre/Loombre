// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/capability-view.ts
//
// W1/D-1 (2026-08-07): shared derivation for "does this machine have any
// hardware acceleration?" — used by BOTH capability surfaces (setup
// wizard HardwareStep and Admin → System's CapabilitiesCard) so they can
// never disagree, and unit-testable without a component harness (the
// wizard-state.ts posture, applied to the one derivation both sides
// need).
//
// The predicate is "no NON-software backend verified any capability" —
// NOT "every backend is empty". On the common GPU-less outcome (a
// Parallels VM, a headless server) the probe still verifies the software
// backend's decode/encode just fine, so an every-backend-empty check
// would stay silent on exactly the machine this copy exists for (opus
// review W1-R2). The software row never counts as acceleration; it is
// the fallback tier the copy is explaining.

export interface CapabilityBackendLike {
  name: string;
  decode: readonly string[];
  encode: readonly string[];
  toneMap: readonly string[];
}

export interface CapabilityReportLike {
  backends: readonly CapabilityBackendLike[];
}

export function hasNoAcceleratedCapabilities(report: CapabilityReportLike): boolean {
  return report.backends.every(
    (b) => b.name === "software" || (b.decode.length === 0 && b.encode.length === 0 && b.toneMap.length === 0),
  );
}

/** The plain-language explanation both surfaces show when
 *  hasNoAcceleratedCapabilities is true — one string so the wizard and
 *  the System page can never drift apart. */
export const NO_ACCELERATION_COPY =
  "No hardware acceleration was found on this machine (common in virtual machines and on servers " +
  "without a GPU). Loombre will use software for video decoding, encoding, and HDR conversion — " +
  "a fully supported setup that simply uses more CPU during transcoding.";
