// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-policy.ts
//
// ServerPolicy resolution (docs/PLAYBACK.md §2.4, Phase 3 §11 step 6b
// deliverable 2): §2.4's documented resolved-defaults + the env overrides
// this step names for the fields that STAYED plain env (LOOMBRE_TIER,
// LOOMBRE_ALLOW_TRANSCODE — neither is an Addendum A registry entry, see
// below).
//
// `ladderRungs` = the §7 default table constant, reused VERBATIM from
// packages/playback-engine/matrix/fixtures/policies.yaml's own
// `t0-default`/`t1-cpu-tonemap`/... fixtures (every one of them shares this
// exact 6-rung table) — so this server's real ladder matches every
// matrix-tested case byte-for-byte, not a freshly-transcribed (and
// possibly drifted) copy. Still the ULTIMATE fallback here (used only if
// SettingsService somehow has no effective value at all, defensive-only —
// see resolveServerPolicyFromSettings below).
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): maxSimultaneousTranscodes,
// hevcEncodePreferred (the OPERATOR PREFERENCE half — capability
// verification stays computed from VerifiedCapabilities, never a static
// setting), allowToneMapCpu, and ladderRungs moved OUT of this module's
// own env/hardcoded resolution into packages/shared/src/settings-registry.ts's
// transcode.* entries, resolved via SettingsService and passed in as
// `SettingsPolicyInputs` below — `resolveServerPolicy` no longer reads
// LOOMBRE_MAX_TRANSCODES itself (previously handled by the now-deleted
// `resolveServerPolicyFromEnv`/`parseEnvMaxTranscodes`/
// `TIER_DEFAULT_MAX_TRANSCODES`) — that env var lives on ONLY as
// transcode.maxSimultaneousTranscodes's env-PIN input inside
// settings-resolve.ts's resolution (A8), never read directly here again.
// `resolveServerPolicyFromSettings` is the new real call site
// (plan-assembly.ts), reading the SettingsService cache AT USE TIME (once
// per plan/admission request — see that module's header for why this
// satisfies the A5 law: an admission check that reads the effective cap at
// admission time can only ever refuse NEW admissions on a lowered cap,
// never touch an already-created session row). `resolveServerPolicy`
// itself stays exported + pure (env/caps/settings all passed in) for unit
// testing without a SettingsService — see resolve-policy.spec.ts.
//
// LOOMBRE_TIER/LOOMBRE_ALLOW_TRANSCODE deliberately stay plain env reads:
// neither is in Addendum A's registry (the addendum's A3 read-site list
// names transcode.maxSimultaneousTranscodes/hevcEncodePreferred/
// allowToneMapCpu/ladderRungs specifically, not tier or the transcode
// on/off switch) — out of this lane's migration scope.

import type { LadderRung, ServerPolicy, VerifiedCapabilities } from "@loombre/playback-engine";
import type { SettingsService } from "../settings/settings.service.js";

export const DEFAULT_LADDER_RUNGS: LadderRung[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
];

export function parseEnvTier(raw: string | undefined): 0 | 1 | 2 {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return 0;
}

export function parseEnvBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "0" || lowered === "false" || lowered === "off" || lowered === "no") return false;
  if (lowered === "1" || lowered === "true" || lowered === "on" || lowered === "yes") return true;
  return defaultValue;
}

export interface ResolveServerPolicyEnv {
  tier?: string;
  allowTranscode?: string;
}

/**
 * SPF-10 — the CAPABILITY half of `hevcEncodePreferred` (§2.4's other half,
 * the operator PREFERENCE setting, is ANDed in by the caller below).
 *
 * `caps.backends` always carries a `software` entry whose `encode` array
 * includes `hevc` (resolve-caps.ts's fallback synthesizes it; every real
 * probe row verifies libx265 too) — treating ANY backend's hevc encode as
 * "verified" therefore made this true on EVERY box, hardware or not. Two
 * measured costs that hid behind that: (1) a software-only Tier-0 box would
 * encode libx265 `veryfast`, 2-4x slower than libx264, and cannot keep a
 * >=1080p ladder rung realtime; (2) a box whose hardware encoder only does
 * h264 (older NVENC/QSV/VAAPI/AMF) would still get an hevc-swapped ladder
 * (ladder.ts only checks `policy.hevcEncodePreferred` + device support, not
 * caps), fail hardware.ts's `encodeCoversTargets` for that ladder, and fall
 * all the way to full software with no `-hwaccel` at all — the WORST route
 * on that box, chosen instead of its own working hardware h264 route.
 *
 * The fix: a non-software backend that verifies hevc encode is real
 * evidence software never was. Failing that, software hevc is preferred
 * ONLY when there is genuine CPU headroom (tier >= 1) AND no hardware
 * encode route exists at all (a non-software backend verifying h264 means
 * THAT route should win, not a software hevc swap) AND software itself
 * verifies hevc. Tier 0 — the small-box tier this run's whole complaint is
 * about — never prefers software hevc: it has no CPU headroom to spend on
 * the 2-4x cost, and if a hardware route exists this rule already lost to
 * it above.
 */
function hevcVerified(caps: VerifiedCapabilities, tier: 0 | 1 | 2): boolean {
  const nonSoftware = caps.backends.filter((b) => b.backend !== "software");
  if (nonSoftware.some((b) => b.encode.includes("hevc"))) return true;
  if (tier < 1) return false;
  if (nonSoftware.some((b) => b.encode.length > 0)) return false;
  const software = caps.backends.find((b) => b.backend === "software");
  return software !== undefined && software.encode.includes("hevc");
}

/** The four transcode.* effective values (packages/shared/src/
 *  settings-registry.ts), already resolved by the caller (env-pin > DB >
 *  default, A8) — this module never reads SettingsService's cache itself,
 *  keeping `resolveServerPolicy` a pure function of its arguments alone. */
export interface SettingsPolicyInputs {
  maxSimultaneousTranscodes: number;
  /** Operator PREFERENCE only (transcode.hevcEncodePreferred) — ANDed with
   *  actual verified capability below; this is never trusted alone. */
  hevcEncodePreferred: boolean;
  /** Operator PREFERENCE (transcode.av1EncodePreferred), forwarded VERBATIM
   *  — deliberately NOT ANDed with capability. See the pass-through in
   *  `resolveServerPolicy` below and docs/PLAYBACK.md §2.4. */
  av1EncodePreferred: boolean;
  allowToneMapCpu: ServerPolicy["allowToneMapCpu"];
  ladderRungs: LadderRung[];
}

/** Pure given its env/settings inputs (resolveServerPolicyFromSettings
 *  below reads `process.env` + a real SettingsService for the actual
 *  controller call site) — unit-testable without touching the process
 *  environment or a database. */
export function resolveServerPolicy(
  env: ResolveServerPolicyEnv,
  caps: VerifiedCapabilities,
  settings: SettingsPolicyInputs,
): ServerPolicy {
  const tier = parseEnvTier(env.tier);
  const allowTranscode = parseEnvBoolean(env.allowTranscode, true);
  const hevcEncodePreferred = settings.hevcEncodePreferred && hevcVerified(caps, tier);

  return {
    allowTranscode,
    allowToneMapCpu: settings.allowToneMapCpu,
    tier,
    preferredTextSubMode: "hls-vtt",
    preserveAssStyling: false,
    audioTranscodeCodecPriority: ["opus", "aac"],
    maxSimultaneousTranscodes: settings.maxSimultaneousTranscodes,
    ladderRungs: settings.ladderRungs,
    segmentDurationSec: 6,
    hevcEncodePreferred,
    // VERBATIM — deliberately NOT `&& av1Verified` (docs/PLAYBACK.md §2.4,
    // LD-7). hevc's preference is resolved two lines up because its only
    // gate is a capability fact; AV1's gate is a TIER LAW (§7.2, LD-16)
    // that must be enforced INSIDE the pure engine, from `caps` +
    // `policy.tier`, where the matrix can prove its unreachability property
    // (§10 property 5) over randomized inputs. Pre-resolving it here would
    // put the law's enforcement outside the tested function — exactly the
    // reason/flag-drift failure class the shared-predicate rule exists to
    // prevent. Tier-0 lens: a preference flag alone never costs a small
    // server a CPU cycle; the engine's eligibility gate decides what it may
    // actually do.
    av1EncodePreferred: settings.av1EncodePreferred,
  };
}

/** The real controller call site (plan-assembly.ts): reads LOOMBRE_TIER/
 *  LOOMBRE_ALLOW_TRANSCODE from process.env (unmigrated, see this file's
 *  header) and the four transcode.* settings from `settingsService`'s
 *  cache AT USE TIME (once per plan/admission request — no caching of its
 *  own beyond what SettingsService itself already does). `?? DEFAULT_*`
 *  fallbacks are defensive-only (SettingsService.requireLoaded() throws
 *  before this could ever see an unloaded cache in production). */
export function resolveServerPolicyFromSettings(settingsService: SettingsService, caps: VerifiedCapabilities): ServerPolicy {
  const tier = process.env["LOOMBRE_TIER"];
  const allowTranscode = process.env["LOOMBRE_ALLOW_TRANSCODE"];

  const maxSimultaneousTranscodes =
    (settingsService.getEffective("transcode.maxSimultaneousTranscodes")?.value as number | undefined) ?? 1;
  const hevcEncodePreferred =
    (settingsService.getEffective("transcode.hevcEncodePreferred")?.value as boolean | undefined) ?? true;
  const allowToneMapCpu =
    (settingsService.getEffective("transcode.allowToneMapCpu")?.value as ServerPolicy["allowToneMapCpu"] | undefined) ??
    "tier-gated";
  const ladderRungs = (settingsService.getEffective("transcode.ladderRungs")?.value as LadderRung[] | undefined) ?? DEFAULT_LADDER_RUNGS;
  // `?? false` mirrors the registry default (owner-decision D5, opt-in) —
  // defensive only, like every other fallback here.
  const av1EncodePreferred =
    (settingsService.getEffective("transcode.av1EncodePreferred")?.value as boolean | undefined) ?? false;

  return resolveServerPolicy(
    {
      ...(tier !== undefined ? { tier } : {}),
      ...(allowTranscode !== undefined ? { allowTranscode } : {}),
    },
    caps,
    { maxSimultaneousTranscodes, hevcEncodePreferred, av1EncodePreferred, allowToneMapCpu, ladderRungs },
  );
}
