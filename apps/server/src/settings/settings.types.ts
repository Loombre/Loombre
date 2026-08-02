// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/settings.types.ts
//
// API FREEZE for lane S2 (STATE.md Addendum A, lane S1's deliverable): the
// exact wire shapes S2 documents in packages/contract/openapi.yaml and
// generates the SDK from. settings.service.ts / provider-keys.service.ts
// return values structurally satisfying these interfaces (checked by tsc,
// not merely documented) so the frozen shape and the real implementation
// can never silently drift apart. openapi.yaml itself is NOT touched here
// (S2 owns it) — these are the TypeScript source S2 writes the YAML schema
// FROM.
//
// Endpoints these back (S2 wires the controllers):
//   GET  /v1/admin/settings         -> AdminSettingsResponse
//   GET  /v1/admin/settings/schema  -> AdminSettingsSchemaResponse
//   PUT  /v1/admin/settings/{key}   -> UpdateSettingResponse (request body: UpdateSettingRequest)
//   PUT  /v1/admin/provider-keys/{provider}        -> 204 no body (request body: SetProviderKeyRequest)
//   DELETE /v1/admin/provider-keys/{provider}      -> 204 no body
//   (No GET-per-provider exists anywhere: statuses ride on GET /admin/settings
//   only, and key VALUES are never readable — A9. The 204s were settled at
//   S2's contract authoring; this comment was reconciled to match.)

import type { SettingsCategory, SettingsScope, SettingsValueSource } from "@loombre/shared";

/** One entry of GET /v1/admin/settings's `settings` array — the per-key
 *  EFFECTIVE value, independent of whether it came from env/DB/default. */
export interface AdminSettingValueDto {
  key: string;
  value: unknown;
  source: SettingsValueSource;
  requiresRestart: boolean;
  /** True iff an env pin is active RIGHT NOW (A8) — value above is always
   *  the env value in that case, and any stored DB value is inert. */
  locked: boolean;
  lockedBy?: string;
}

export interface AdminSettingsResponseDto {
  settings: AdminSettingValueDto[];
  /** A5: keys whose CURRENT effective value differs from what it was at
   *  boot — non-empty means "some requiresRestart change is pending a
   *  restart to take effect". */
  restartPendingKeys: string[];
  providerKeys: ProviderKeyStatusDto[];
  /** Optional mail transport run (E5/M10) — ADDITIVE field, mirrors
   *  providerKeys' "status only, never the value" shape for the ONE
   *  mail-credentials keyring entry (settings/mail-credentials.service.ts).
   *  Mail credentials are optional overall (M8: unauthenticated SMTP relays
   *  are legal), so this is never load-bearing for whether mail can send. */
  mailCredentials: MailCredentialsStatusDto;
}

/** One entry of GET /v1/admin/settings/schema's `entries` array — the pure
 *  registry projection (no live value): what the UI form renderer and the
 *  generated operator/admin docs both build from (AD3: one source, three
 *  consumers — the registry itself is the first consumer, this DTO is the
 *  wire projection of it). */
export interface AdminSettingSchemaEntryDto {
  key: string;
  category: SettingsCategory;
  description: string;
  caution?: string;
  scope: SettingsScope;
  requiresRestart: boolean;
  envVar?: string;
  default: unknown;
  /** z.toJSONSchema(entry.schema) — AD3. */
  valueSchema: Record<string, unknown>;
  /** Mirrors AdminSettingValueDto.locked/lockedBy for the SAME key, so the
   *  UI can render a read-only, "set by environment" control without a
   *  second round trip to GET /v1/admin/settings. */
  locked: boolean;
  lockedBy?: string;
}

export interface AdminSettingsSchemaResponseDto {
  entries: AdminSettingSchemaEntryDto[];
}

export interface UpdateSettingRequestDto {
  value: unknown;
}

export interface UpdateSettingResponseDto {
  key: string;
  value: unknown;
  source: SettingsValueSource;
  requiresRestart: boolean;
  /** Whether THIS key now appears in restartPendingKeys after this write —
   *  a convenience echo so the UI doesn't need a second GET just to show
   *  "restart required" inline on the control that was just changed. */
  restartPending: boolean;
}

// ---- A9: provider-key DTOs ----

export type ProviderName = "tmdb" | "tvdb";

export interface ProviderKeyStatusDto {
  provider: ProviderName;
  set: boolean;
  /** null when `set` is false. Status/read paths NEVER return or log the
   *  key value itself (A9) — this is the ENTIRE shape a status query ever
   *  returns. */
  source: "env" | "keyring" | null;
  /** Present only when source === 'keyring' (AD4: the keyring envelope
   *  {value, setAtMs} is what this is read from — an env-sourced key has
   *  no "when was it set" concept this server can observe). */
  lastSetMs?: number;
}

export interface SetProviderKeyRequestDto {
  key: string;
}

// ---- Optional mail transport run (E5/M10): mail-credentials DTOs ----
// (settings/mail-credentials.service.ts, sibling of provider-keys.service.ts
// — A9 pattern, deliberately NOT grafted onto ProviderName's closed
// tmdb|tvdb set.)
//   PUT    /v1/admin/mail/credentials -> 204 no body (request body: SetMailCredentialsRequest)
//   DELETE /v1/admin/mail/credentials -> 204 no body
//   (No GET-per-credential exists, same A9 discipline as provider keys —
//   status rides on GET /admin/settings's additive `mailCredentials` only.)

export interface MailCredentialsStatusDto {
  configured: boolean;
  /** null when not configured, or when sourced from the environment (which
   *  has no "when was it set" concept this server can observe). */
  setAtMs: number | null;
  /** null when `configured` is false. */
  source: "env" | "keyring" | null;
}

export interface SetMailCredentialsRequestDto {
  username: string;
  password: string;
}
