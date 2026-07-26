// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-manifest.ts
//
// LPP v1, Lane W5: pure, framework-free decision logic behind the admin
// Plugins surface — capability privacy copy (household register, C4/C7),
// the plugin status pill (mirrors lib/admin-status.ts's describeJobStatus/
// describeSessionStatus shape exactly), and the plugin config form's
// field-by-field draft/validation helpers built on TOP of (never
// duplicating) lib/settings-schema-widget.ts's resolveWidgetKind/
// numberConstraints/enumOptions/validateAgainstJsonSchema — C3's "the
// key-agnostic schema->widget renderer you MUST reuse for plugin config
// forms" is honored by importing that module rather than re-deriving a
// second widget vocabulary here.
//
// Kept React-free (no import from "react" anywhere in this file) so it's
// directly unit-testable without a component-rendering harness — this
// repo's established web test convention (settings-schema-widget.ts,
// admin-status.ts, app/setup/wizard-state.ts, ...).

import type { JsonSchemaLike, SettingsWidgetKind } from "./settings-schema-widget.js";
import { resolveWidgetKind, validateAgainstJsonSchema } from "./settings-schema-widget.js";

// ── Wire shapes (mirror packages/contract/openapi.yaml's Admin: plugins
//    schemas — kept local rather than importing @loombre/sdk's generated
//    types INTO this pure module, so it stays testable with hand-built
//    fixtures; the real page/component layer imports the generated
//    `components["schemas"][...]` types and those satisfy these shapes
//    structurally) ──

export interface PluginMetadataProviderCapability {
  type: "metadata-provider";
  mediaKinds: string[];
  contentClass: "general" | "restricted";
}

export interface PluginEventSubscriberCapability {
  type: "event-subscriber";
  eventTypes: string[];
  contentClass: "general" | "restricted";
}

export type PluginCapability = PluginMetadataProviderCapability | PluginEventSubscriberCapability;

// ── C4/C7: per-capability privacy lines, household register, "what can
//    this plugin see" framed for someone who has never heard the words
//    "capability" or "webhook". These are the EXACT strings the wizard's
//    confirmation screen and the detail page's manifest summary render —
//    tested verbatim below and quoted verbatim in this lane's final report. ──

const MEDIA_KIND_LABELS: Record<string, string> = { movie: "movies", tv: "TV shows", music: "music" };

function describeMediaKinds(mediaKinds: readonly string[]): string {
  const labels = mediaKinds.map((k) => MEDIA_KIND_LABELS[k] ?? k);
  if (labels.length === 0) return "your media";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/** The exact copy a metadata-provider capability card shows — what this
 *  plugin can see about libraries it's attached to, and what it can send
 *  back. `general` vs `restricted` scope explained in the SAME sentence
 *  style docs/PLAN.md §6.4 and the settings register already use for
 *  restricted content ("kept separate", not jargon like "content class"). */
export function describeMetadataProviderScope(capability: PluginMetadataProviderCapability): string {
  const restrictedNote =
    capability.contentClass === "restricted"
      ? " It only ever sees restricted libraries — never a general one."
      : " It can be used on any library, restricted or not.";
  return (
    `Can look up titles, years, and other identifying details for ${describeMediaKinds(capability.mediaKinds)} ` +
    `in any library it's attached to, and sends back matched descriptions and artwork for them.` +
    ` It never sees anything about who's watching or listening.${restrictedNote}`
  );
}

/** The exact copy an event-subscriber capability card shows — it only ever
 *  receives what an admin explicitly grants (eventTypeGrants), described
 *  as "the activity feed", never "events"/"webhooks"/"the outbox". */
export function describeEventSubscriberScope(capability: PluginEventSubscriberCapability): string {
  const restrictedNote =
    capability.contentClass === "restricted"
      ? " It only ever receives activity involving restricted content if you grant that on purpose."
      : " It never receives activity involving restricted content.";
  return (
    `Receives the activity feed events you choose to send it — nothing more than what you grant below.` +
    ` By default, who did something is shown as an anonymous id, not a real account.${restrictedNote}`
  );
}

export function describeCapabilityScope(capability: PluginCapability): string {
  return capability.type === "metadata-provider" ? describeMetadataProviderScope(capability) : describeEventSubscriberScope(capability);
}

export function capabilityTypeLabel(type: string): string {
  if (type === "metadata-provider") return "Metadata provider";
  if (type === "event-subscriber") return "Activity feed subscriber";
  return type;
}

// ── Status pill — mirrors lib/admin-status.ts's describeJobStatus/
//    describeSessionStatus shape and PillTone vocabulary exactly, so
//    components/admin/StatusPill.tsx renders a plugin's status with zero
//    new code. ──

export type PillTone = "neutral" | "info" | "success" | "danger" | "warning";

export interface StatusPillInfo {
  label: string;
  tone: PillTone;
}

export interface PluginStatusInput {
  enabled: boolean;
  healthState: "unknown" | "healthy" | "unhealthy";
  disabledReason: "admin" | "breaker" | "scope-change" | null;
}

/** One pill summarizing enabled/health/breaker state together (the admin
 *  list/detail pages need exactly ONE glanceable pill per plugin, not
 *  three) — falls back to a neutral pill showing the raw healthState for
 *  anything this map hasn't been updated for yet, matching
 *  describeJobStatus/describeSessionStatus's own "never throw on a future
 *  additive value" posture. */
export function describePluginStatus(plugin: PluginStatusInput): StatusPillInfo {
  if (!plugin.enabled) {
    if (plugin.disabledReason === "scope-change") return { label: "Needs re-approval", tone: "warning" };
    if (plugin.disabledReason === "breaker") return { label: "Disabled (too many failures)", tone: "danger" };
    return { label: "Disabled", tone: "neutral" };
  }
  if (plugin.healthState === "healthy") return { label: "Enabled", tone: "success" };
  if (plugin.healthState === "unhealthy") return { label: "Enabled (unhealthy)", tone: "danger" };
  return { label: "Enabled (health unknown)", tone: "info" };
}

// ── Config form: one JSON-Schema-subset field, decided the SAME way
//    lib/settings-schema-widget.ts decides a registry key's widget, plus
//    ONE LPP-specific extension: `secret: true` (only ever legal on a
//    `type: "string"` leaf, packages/plugin-protocol/src/json-schema-
//    subset.ts) routes to a write-only field instead of resolveWidgetKind's
//    ordinary "string" control. ──

export interface PluginConfigFieldSchema extends JsonSchemaLike {
  type?: string;
  secret?: boolean;
}

export interface PluginConfigSchema {
  type: "object";
  properties: Record<string, PluginConfigFieldSchema>;
  required?: string[];
}

export type PluginConfigWidgetKind = SettingsWidgetKind | "secret";

export function resolvePluginFieldWidgetKind(schema: PluginConfigFieldSchema): PluginConfigWidgetKind {
  if (schema.type === "string" && schema["secret"] === true) return "secret";
  return resolveWidgetKind(schema);
}

/** Field names in `configSchema` marked `secret: true` — mirrors
 *  packages/plugin-protocol/src/json-schema-subset.ts's
 *  listTopLevelSecretFieldNames() exactly (client-side re-derivation off
 *  the SAME wire shape, not a second source of truth: the server is always
 *  the one that actually enforces the split at submit time). */
export function pluginConfigSecretFieldNames(schema: PluginConfigSchema): string[] {
  return Object.entries(schema.properties)
    .filter(([, field]) => field.type === "string" && field["secret"] === true)
    .map(([key]) => key);
}

/** Initial per-field draft for the config form: non-secret fields start
 *  from the plugin's CURRENT stored value if present, else the schema's
 *  own `default`, else an empty/absent value; secret fields ALWAYS start
 *  blank (there is nothing to pre-fill them with — the server never
 *  returns a secret value, see ProviderKeysCard's identical reasoning). An
 *  absent secret draft (vs. an explicit empty string) matters at submit
 *  time: see buildConfigSubmission below. */
export function buildInitialConfigDraft(schema: PluginConfigSchema, currentValues: Record<string, unknown>): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (resolvePluginFieldWidgetKind(field) === "secret") continue; // stays absent until the admin types a replacement
    if (key in currentValues) {
      draft[key] = currentValues[key];
    } else if ("default" in field) {
      draft[key] = field["default"];
    }
  }
  return draft;
}

/**
 * Submission-time assembly: non-secret fields come from `draft` verbatim;
 * a secret field is included ONLY if the admin actually typed a
 * replacement value in `secretDrafts` (a separate map, since "" is a
 * meaningful attempted value distinct from "untouched" — an untouched
 * secret field must be OMITTED from the submitted object so the server's
 * updateConfig leaves its existing keyring entry alone, matching this
 * lane's report note on PluginLifecycleService.updateConfig's known gap:
 * it does not clear a keyring entry for a secret field the caller stops
 * submitting, so omission = "leave as-is", never "clear").
 */
export function buildConfigSubmission(
  schema: PluginConfigSchema,
  draft: Record<string, unknown>,
  secretDrafts: Record<string, string>,
): Record<string, unknown> {
  const submission: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (resolvePluginFieldWidgetKind(field) === "secret") {
      const typed = secretDrafts[key];
      if (typed !== undefined && typed.length > 0) submission[key] = typed;
      continue;
    }
    if (key in draft) submission[key] = draft[key];
  }
  return submission;
}

export interface PluginConfigValidationResult {
  errors: Record<string, string>;
  valid: boolean;
}

/** Validates every NON-secret field against its own schema (secret fields
 *  are only checked for "required but blank" — their content can't be
 *  schema-validated client-side beyond that, since minLength/pattern would
 *  leak shape information about a value already in the keyring for an
 *  untouched field). Mirrors SettingField.tsx's "validate before enabling
 *  Save" posture, generalized to a whole-object form instead of one field
 *  at a time. */
export function validatePluginConfigDraft(
  schema: PluginConfigSchema,
  draft: Record<string, unknown>,
  secretDrafts: Record<string, string>,
  requireAllSecrets: boolean,
): PluginConfigValidationResult {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, field] of Object.entries(schema.properties)) {
    if (resolvePluginFieldWidgetKind(field) === "secret") {
      const typed = secretDrafts[key];
      const isBlank = typed === undefined || typed.length === 0;
      if (isBlank && required.has(key) && requireAllSecrets) {
        errors[key] = "This value is required.";
      }
      continue;
    }
    const value = draft[key];
    if (value === undefined) {
      if (required.has(key)) errors[key] = "This value is required.";
      continue;
    }
    const error = validateAgainstJsonSchema(value, field);
    if (error) errors[key] = error;
  }
  return { errors, valid: Object.keys(errors).length === 0 };
}

// ── Event-grant subset helpers ──

/** Union of every event-subscriber capability's requested eventTypes, in
 *  first-seen order (mirrors apps/server's own PluginRegistrationService.
 *  validateGrantAgainstManifest — a client-side re-derivation for display/
 *  selection purposes, never the enforcement point). */
export function requestedEventTypes(capabilities: readonly PluginCapability[]): string[] {
  const seen: string[] = [];
  for (const capability of capabilities) {
    if (capability.type !== "event-subscriber") continue;
    for (const eventType of capability.eventTypes) {
      if (!seen.includes(eventType)) seen.push(eventType);
    }
  }
  return seen;
}

export function isValidGrantSubset(requested: readonly string[], granted: readonly string[]): boolean {
  return granted.every((t) => requested.includes(t));
}
