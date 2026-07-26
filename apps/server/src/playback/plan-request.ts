// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/plan-request.ts
//
// Shared request-body parsing for POST /playback/plan and
// POST /playback/sessions — both take the contract's PlanRequest shape
// (packages/contract/openapi.yaml). Validation failures collapse to a
// single `{ ok: false, detail }` the caller 422s with (mirrors every other
// controller's manual-validation style in this codebase, e.g.
// progress.controller.ts), rather than a class-validator/DTO pipeline this
// codebase doesn't use elsewhere.
//
// device validation is delegated to DeviceProfileValidatorService
// (apps/server/src/common/device-profile-validator.ts, P2.3/P2.12) — the
// SAME Ajv-compiled schema login's deviceProfile uses, so a PlanRequest's
// embedded DeviceProfile can never be "more loosely" checked than the one
// captured at login.
//
// `selection` (Phase 3 §11 step 6b, docs/PLAYBACK.md §2.6): optional
// request-body pins for video/audio/subtitle stream index, matching the
// contract's TrackSelection schema (all three fields optional/nullable —
// omitting the whole object, or any one field, means "no pin for that
// track kind", resolved by resolve-selection.ts's normal cascade). Loosely
// validated here (shape only — the SelectionPins consumer already treats
// an out-of-range/nonexistent index as "not pinned", so this parser only
// needs to reject a structurally wrong shape, not a semantically stale one).

import type { DeviceProfile } from "@loombre/playback-engine";
import type { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import type { SelectionPins } from "./resolve-selection.js";

export interface ParsedPlanRequest {
  itemId: string;
  mediaFileId?: string;
  device: DeviceProfile;
  network: { maxBitrateBps: number; isLocal: boolean };
  mode: "stream" | "download";
  selection?: SelectionPins;
}

export type ParsePlanRequestResult = { ok: true; value: ParsedPlanRequest } | { ok: false; detail: string };

function isValidPinField(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

function parseSelectionPins(raw: unknown): { ok: true; value: SelectionPins | undefined } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, detail: "selection must be an object." };
  }
  const obj = raw as Record<string, unknown>;
  if (
    !isValidPinField(obj["videoStreamIndex"]) ||
    !isValidPinField(obj["audioStreamIndex"]) ||
    !isValidPinField(obj["subtitleStreamIndex"])
  ) {
    return { ok: false, detail: "selection.{videoStreamIndex,audioStreamIndex,subtitleStreamIndex} must each be a number, null, or omitted." };
  }
  return {
    ok: true,
    value: {
      ...(obj["videoStreamIndex"] !== undefined ? { videoStreamIndex: obj["videoStreamIndex"] as number | null } : {}),
      ...(obj["audioStreamIndex"] !== undefined ? { audioStreamIndex: obj["audioStreamIndex"] as number | null } : {}),
      ...(obj["subtitleStreamIndex"] !== undefined ? { subtitleStreamIndex: obj["subtitleStreamIndex"] as number | null } : {}),
    },
  };
}

export function parsePlanRequestBody(
  rawBody: unknown,
  deviceProfileValidator: DeviceProfileValidatorService,
): ParsePlanRequestResult {
  const body = (rawBody ?? {}) as Record<string, unknown>;

  if (typeof body["itemId"] !== "string" || body["itemId"].length === 0) {
    return { ok: false, detail: "itemId (uuid string) is required." };
  }

  const mediaFileIdRaw = body["mediaFileId"];
  if (mediaFileIdRaw !== undefined && mediaFileIdRaw !== null && typeof mediaFileIdRaw !== "string") {
    return { ok: false, detail: "mediaFileId must be a string or null." };
  }

  const deviceCheck = deviceProfileValidator.validate(body["device"]);
  if (!deviceCheck.valid) {
    return { ok: false, detail: `device: ${deviceCheck.errors}` };
  }

  const network = body["network"] as Record<string, unknown> | undefined;
  if (
    typeof network !== "object" ||
    network === null ||
    typeof network["maxBitrateBps"] !== "number" ||
    typeof network["isLocal"] !== "boolean"
  ) {
    return { ok: false, detail: "network ({maxBitrateBps, isLocal}) is required." };
  }

  if (body["mode"] !== "stream" && body["mode"] !== "download") {
    return { ok: false, detail: "mode must be 'stream' or 'download'." };
  }

  const selectionResult = parseSelectionPins(body["selection"]);
  if (!selectionResult.ok) {
    return { ok: false, detail: selectionResult.detail };
  }

  return {
    ok: true,
    value: {
      itemId: body["itemId"],
      ...(typeof mediaFileIdRaw === "string" ? { mediaFileId: mediaFileIdRaw } : {}),
      // Ajv has already proven this matches DeviceProfile's shape
      // (DEVICE_PROFILE_SCHEMA mirrors the contract 1:1); the cast carries
      // that proof across the type-system boundary Ajv itself doesn't
      // narrow (see device-profile-validator.ts's header).
      device: body["device"] as unknown as DeviceProfile,
      network: { maxBitrateBps: network["maxBitrateBps"] as number, isLocal: network["isLocal"] as boolean },
      mode: body["mode"],
      ...(selectionResult.value !== undefined ? { selection: selectionResult.value } : {}),
    },
  };
}
