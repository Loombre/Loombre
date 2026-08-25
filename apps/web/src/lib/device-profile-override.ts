// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/device-profile-override.ts
//
// d3-a6 (A/v8-requal): a deliberate, per-browser device-profile override
// for the SESSION-CREATE capability payload. The live probe
// (lib/device-profile.ts) is HONEST about the current display — on an SDR
// rig it reports hdr10:false, which the planner correctly answers with the
// 1080p tone-map plan. That honesty made the V8 video-copy shape
// unreachable from browser QA: the deliberately-stored HDR device profile
// from login was always overridden by the live probe at plan time.
//
// DECISION (owner ruling gave two admissible mechanisms; this module is
// the recorded choice): the live probe REMAINS authoritative for every
// real user. An automatic stored-profile-wins rule was rejected because
//   (a) the Device schema has no marker separating a curated/explicit
//       capabilityProfile from an ordinary login-probe snapshot — for
//       every real web login the stored profile IS just the probe as of
//       login time, so the rule cannot be scoped to curated profiles; and
//   (b) it would let a stale login-time claim outrank the current display
//       both ways: a laptop that logged in on an HDR external display and
//       now plays on its SDR panel would be served an HDR10 video-copy
//       with no tone-map (washed-out image), and the reverse strands a
//       real HDR display at tone-mapped SDR.
// Instead, a JSON merge-patch stored under localStorage key
// `loombre.device-profile-override.v1` is merged ABOVE the live probe by
// the session-create/plan payload builders (lib/playback-session.ts,
// lib/playback-fallback.ts), the probe filling every field the patch does
// not name. No key -> the probe result is returned untouched, so default
// planning is byte-identical to before. Login/claim (LoginRequest.
// deviceProfile — what the server STORES for the device) deliberately stay
// on the raw probe: the stored profile keeps meaning "what this browser
// honestly probed at login".
//
// Merge semantics (spec'd in device-profile-override.test.ts): plain
// objects merge recursively; arrays, scalars, AND null assign wholesale
// (null is a legal DeviceProfile value — e.g. maxBitrateBps — never a
// delete marker, deviating from RFC 7386 on purpose). Unknown keys are
// carried verbatim: the server's strict Ajv validator is the schema
// authority, so a typo'd patch fails the session create LOUDLY with a 422
// instead of silently planning on a half-applied override.
//
// QA usage (the V8 rig): after session injection, e.g.
//   localStorage.setItem("loombre.device-profile-override.v1",
//     JSON.stringify(<device-profile-hdr.json contents>))
// and remove the key to return to honest probing.

import { buildDeviceProfile, type DeviceProfile } from "./device-profile.js";

export const DEVICE_PROFILE_OVERRIDE_KEY = "loombre.device-profile-override.v1";

/** The one storage method this module needs — injectable in tests (same
 *  "inject the impure edges" pattern as device-profile.ts's ProbeEnv). */
export interface OverrideStorage {
  getItem(key: string): string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The real browser storage, or null when there is none (SSR) or the
 *  accessor itself throws (storage-blocked browser modes). */
function defaultStorage(): OverrideStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the stored merge-patch, or null when absent/unreadable/not a plain
 * JSON object. Never throws: a corrupt or blocked store means "no
 * override", exactly like the key not existing.
 */
export function readDeviceProfileOverride(
  storage: OverrideStorage | null = defaultStorage(),
): Record<string, unknown> | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(DEVICE_PROFILE_OVERRIDE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in base ? mergeValue(base[key], value) : value;
  }
  return merged;
}

/** Pure merge of a patch above the probed profile (see header for the
 *  semantics). Neither input is mutated. */
export function mergeDeviceProfileOverride(
  probed: DeviceProfile,
  override: Record<string, unknown>,
): DeviceProfile {
  return mergeValue(probed, override) as DeviceProfile;
}

/**
 * The session-create capability payload: the live probe, with the stored
 * override (when one exists) merged above it. Without an override the
 * probe's own object is returned untouched.
 */
export async function resolveSessionDeviceProfile(
  probe: () => Promise<DeviceProfile> = buildDeviceProfile,
  storage?: OverrideStorage | null,
): Promise<DeviceProfile> {
  const probed = await probe();
  const override = storage === undefined ? readDeviceProfileOverride() : readDeviceProfileOverride(storage);
  if (override === null) return probed;
  // Deliberate breadcrumb (local console only, never sent anywhere): an
  // active override silently reshaping every plan would be a debugging
  // trap for whoever probes "why is planning wrong on this machine".
  console.info(`[loombre] ${DEVICE_PROFILE_OVERRIDE_KEY} is set — merging it above the live capability probe for playback planning`);
  return mergeDeviceProfileOverride(probed, override);
}
