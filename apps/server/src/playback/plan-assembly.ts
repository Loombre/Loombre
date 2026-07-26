// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/plan-assembly.ts
//
// Assembles a full @loombre/playback-engine PlanInput from a parsed
// PlanRequest + the caller's DB/HTTP context (docs/PLAYBACK.md §1/§2,
// Phase 3 §11 step 6b deliverable 2). ONE call site both
// plan.controller.ts (preview) and sessions.controller.ts (create) share,
// so the two operations can never silently diverge in how they build the
// engine's input.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): `policy` is
// now assembled from SettingsService's effective-value cache
// (resolve-policy.ts's resolveServerPolicyFromSettings) instead of raw
// process.env — read AT USE TIME, i.e. once per plan-preview/session-create
// request, which is exactly sessions.controller.ts's admission-check call
// site (the A5 LAW: a transcode-slot reduction only refuses NEW admissions
// from this point forward — an already-created playback_sessions row is
// never touched by a later settings change). ServerPolicy VALUES change
// where they're ASSEMBLED (here) — packages/playback-engine's plan()
// itself stays untouched and pure.

import type { Request } from "express";
import type { MediaInfoAssembly } from "@loombre/db";
import type { PlanInput } from "@loombre/playback-engine";
import type { LoombreDb } from "../common/db.provider.js";
import type { SettingsService } from "../settings/settings.service.js";
import { assembleNetworkConditions } from "./resolve-network.js";
import { resolveServerPolicyFromSettings } from "./resolve-policy.js";
import { resolveVerifiedCapabilities } from "./resolve-caps.js";
import { resolveTrackSelection, type SelectionPins } from "./resolve-selection.js";
import type { ParsedPlanRequest } from "./plan-request.js";

export interface AssemblePlanInputParams {
  db: LoombreDb;
  req: Request;
  assembly: MediaInfoAssembly;
  parsed: ParsedPlanRequest;
  /** The caller's (already-read) `user_settings.prefs.audioPreferredLanguage`
   *  — see resolve-selection.ts's header for why this module doesn't read
   *  it itself. */
  audioLanguagePref: string | null | undefined;
  settingsService: SettingsService;
}

export async function assemblePlanInput(params: AssemblePlanInputParams): Promise<PlanInput> {
  const { db, req, assembly, parsed, audioLanguagePref, settingsService } = params;

  const device = parsed.device;
  const pins: SelectionPins = parsed.selection ?? {};
  const selection = resolveTrackSelection(assembly.media, pins, audioLanguagePref);
  const network = assembleNetworkConditions(req, parsed.network, device.maxStreamBitrateBps);
  const caps = await resolveVerifiedCapabilities(db);
  const policy = resolveServerPolicyFromSettings(settingsService, caps);

  return {
    media: assembly.media,
    device,
    network,
    policy,
    caps,
    selection,
    mode: parsed.mode,
  };
}
