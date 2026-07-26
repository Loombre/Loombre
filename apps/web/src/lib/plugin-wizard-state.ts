// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-wizard-state.ts
//
// LPP v1, Lane W5: pure, framework-free step sequencing + per-step
// validation for the plugin registration wizard (mission C4: "URL entry ->
// PREVIEW/confirmation screen listing EVERY declared capability + its
// scope in plain language -> config form auto-rendered from configSchema
// -> event-grant selection -> submit -> HMAC secret displayed once ->
// health-check result surfaced"). Mirrors
// apps/web/src/app/setup/wizard-state.ts's shape exactly (StepId/
// STEP_ORDER/nextStep/previousStep, form validation returning an errors
// object, view-state derivation functions) — the established pattern for
// a multi-step admin flow in this codebase, reused rather than reinvented.

import {
  isValidGrantSubset,
  validatePluginConfigDraft,
  type PluginConfigSchema,
} from "./plugin-manifest.js";

export type StepId = "url" | "confirm" | "config" | "grants" | "submitting" | "result";

export const STEP_ORDER: readonly StepId[] = ["url", "confirm", "config", "grants", "submitting", "result"];

export function stepIndex(step: StepId): number {
  return STEP_ORDER.indexOf(step);
}

export function nextStep(current: StepId): StepId {
  const idx = stepIndex(current);
  return STEP_ORDER[Math.min(idx + 1, STEP_ORDER.length - 1)]!;
}

export function previousStep(current: StepId): StepId {
  const idx = stepIndex(current);
  return STEP_ORDER[Math.max(idx - 1, 0)]!;
}

// ── URL step ──

/** Deliberately permissive (matches wizard-state.ts's own EMAIL_PATTERN
 *  posture): this exists to catch an obviously-empty/malformed entry
 *  before a round trip, not to duplicate the server's own SSRF/scheme
 *  validation — previewAdminPlugin's 422 is always the real backstop. */
export function validatePluginUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return "Enter the plugin's web address.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full web address, starting with http:// or https://.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The address must start with http:// or https://.";
  }
  return null;
}

// ── Confirm step: which declared capability TYPES to enable ──

export function canProceedFromConfirm(selectedCapabilityTypes: readonly string[]): boolean {
  return selectedCapabilityTypes.length > 0;
}

// ── Config step ──

export function canProceedFromConfig(
  schema: PluginConfigSchema,
  draft: Record<string, unknown>,
  secretDrafts: Record<string, string>,
): boolean {
  return validatePluginConfigDraft(schema, draft, secretDrafts, true).valid;
}

// ── Grants step: only meaningful when event-subscriber is among the
//    selected capability types; a plugin with no event-subscriber
//    capability (or one the admin didn't select) skips straight through. ──

export function needsGrantsStep(selectedCapabilityTypes: readonly string[]): boolean {
  return selectedCapabilityTypes.includes("event-subscriber");
}

export function canProceedFromGrants(requested: readonly string[], granted: readonly string[]): boolean {
  return isValidGrantSubset(requested, granted);
}

// ── Result step: mission C4's "health-check failure ... offer enable-
//    anyway vs cancel" — the plugin already exists at this point
//    (registration always commits, W2's registerPlugin doc comment), so
//    "cancel" in this UI means an immediate DELETE, stated plainly to the
//    admin rather than left as an implicit side effect. ──

export type ResultViewState = "healthy" | "unhealthy-decision" | "unknown";

export function deriveResultViewState(healthState: "unknown" | "healthy" | "unhealthy"): ResultViewState {
  if (healthState === "healthy") return "healthy";
  if (healthState === "unhealthy") return "unhealthy-decision";
  return "unknown";
}
