// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugin-dto.ts
//
// API FREEZE for lane W5, mirroring apps/server/src/settings/settings.types.ts's
// own header exactly: the wire shapes this lane documents in
// packages/contract/openapi.yaml's Admin: plugins section, structurally
// checked by tsc against admin-plugins.controller.ts's real return values
// so the frozen shape and the implementation can never silently drift
// apart. apps/server deliberately does NOT import @loombre/sdk's generated
// component types for its own DTOs (that package is generated FROM the
// contract for CLIENTS — settings.types.ts's own DTOs are the established
// precedent for why server-side response shapes are hand-written here and
// verified against the contract by the conformance/e2e suites instead).
//
// Endpoints these back (admin-plugins.controller.ts wires the routes):
//   POST   /v1/admin/plugins/preview             -> PluginManifestPreviewDto
//   GET    /v1/admin/plugins                     -> AdminPluginListDto
//   POST   /v1/admin/plugins                     -> RegisterPluginResponseDto
//   GET    /v1/admin/plugins/{id}                 -> AdminPluginDto
//   DELETE /v1/admin/plugins/{id}                 -> 204 no body
//   PUT    /v1/admin/plugins/{id}/config          -> AdminPluginDto
//   PUT    /v1/admin/plugins/{id}/event-grants    -> AdminPluginDto
//   PUT    /v1/admin/plugins/{id}/pseudonymization -> AdminPluginDto (Lane W5b)
//   POST   /v1/admin/plugins/{id}/enable          -> AdminPluginDto
//   POST   /v1/admin/plugins/{id}/disable         -> AdminPluginDto
//   POST   /v1/admin/plugins/{id}/refresh         -> RefreshPluginResponseDto
//   POST   /v1/admin/plugins/{id}/reapprove       -> AdminPluginDto
//   POST   /v1/admin/plugins/{id}/rotate-hmac     -> RotatePluginHmacResponseDto
//
// Lane W5b addition: AdminPluginDto grew an additive optional
// `deliveryStatus` field (packages/contract/openapi.yaml's AdminPlugin
// schema, same name) — see toPluginDeliveryStatusDto below. Only the
// get()/list() read paths in admin-plugins.controller.ts populate it from a
// real plugin_delivery_cursors row; every other AdminPlugin-returning route
// passes `null` through toAdminPluginDto's optional 4th parameter (its
// default), which is schema-valid (deliveryStatus is nullable, not in
// `required`) — those routes never mutate delivery state, so they have
// nothing fresher to report anyway.

import type { PluginDeliveryCursorRow, PluginDisabledReason, PluginEventGrantRow, PluginHealthState, PluginRow } from "@loombre/db";
import type { LppCapability, LppConfig } from "@loombre/plugin-protocol";

export interface PluginEventGrantDto {
  eventType: string;
  grantedAtMs: number;
}

/** packages/contract/openapi.yaml's PluginDeliveryStatus, verbatim field
 *  names — mirrors PluginEventGrantDto's "thin camelCase mirror of the DB
 *  row" shape. */
export interface PluginDeliveryStatusDto {
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  consecutiveFailures: number;
  deliveredBatches: number;
  deliveredEvents: number;
  gapReportedThroughMs: number | null;
}

/** A registered LPP plugin's admin-facing state. Never carries the HMAC
 *  secret or any config secret value (LD1/LD9) — plugin.config already
 *  holds non-secret values only (packages/db/src/query/plugins.ts). */
export interface AdminPluginDto {
  id: string;
  name: string;
  baseUrl: string;
  version: string;
  protocolVersion: number;
  enabled: boolean;
  contentClass: "general" | "restricted";
  grantedCapabilityTypes: string[];
  healthState: PluginHealthState;
  consecutiveFailures: number;
  lastHealthCheckMs: number | null;
  lastOkMs: number | null;
  disabledReason: PluginDisabledReason | null;
  lanAllowlist: string[];
  manifest: Record<string, unknown>;
  config: Record<string, unknown>;
  eventGrants: PluginEventGrantDto[];
  createdAtMs: number;
  updatedAtMs: number;
  approvedAtMs: number;
  pseudonymizeActorIds: boolean;
  deliveryStatus: PluginDeliveryStatusDto | null;
}

export interface AdminPluginListDto {
  items: AdminPluginDto[];
}

export interface RegisterPluginRequestDto {
  url: string;
  grantedCapabilityTypes: string[];
  eventTypeGrants: string[];
  config: Record<string, unknown>;
  lanAllowlist?: string[];
  /** C-2 fix wave: the `manifestDigest` a prior `POST /admin/plugins/preview`
   *  call returned for this exact plugin. Schema-optional (additive, never
   *  breaking a hypothetical older caller) but ENFORCED as required by
   *  plugin-registration.service.ts — omitting it is a 422, and a value
   *  that no longer matches a fresh fetch is a 409 (the manifest changed
   *  since it was previewed; re-preview and confirm again). */
  manifestDigest?: string;
}

/** hmacSecret is returned EXACTLY ONCE (LD1) — never retrievable again. */
export interface RegisterPluginResponseDto {
  plugin: AdminPluginDto;
  hmacSecret: string;
}

export interface UpdatePluginConfigRequestDto {
  config: Record<string, unknown>;
}

export interface UpdatePluginEventGrantsRequestDto {
  eventTypeGrants: string[];
}

export interface ReapprovePluginRequestDto {
  grantedCapabilityTypes: string[];
  eventTypeGrants: string[];
  /** C-2 fix wave — see RegisterPluginRequestDto.manifestDigest's doc
   *  comment; the same pin/409 rule applies to re-approval's preview. */
  manifestDigest?: string;
}

export interface RefreshPluginResponseDto {
  plugin: AdminPluginDto;
  expanded: boolean;
  reasons: string[];
}

export interface RotatePluginHmacResponseDto {
  hmacSecret: string;
}

export interface PreviewPluginRequestDto {
  url: string;
  lanAllowlist?: string[];
}

export interface PluginManifestPreviewDto {
  name: string;
  version: string;
  protocolVersion: number;
  publisher: string;
  description: string;
  capabilities: LppCapability[];
  configSchema: LppConfig;
  requestedEventTypes: string[];
  /** C-2 fix wave: sha256 hex digest of the exact manifest content this
   *  preview validated — see manifest-digest.ts. Always present. */
  manifestDigest: string;
}

export function toPluginEventGrantDto(grant: PluginEventGrantRow): PluginEventGrantDto {
  return {
    eventType: grant.event_type,
    grantedAtMs: grant.granted_at_ms,
  };
}

export function toPluginDeliveryStatusDto(cursor: PluginDeliveryCursorRow): PluginDeliveryStatusDto {
  return {
    lastAttemptMs: cursor.last_attempt_ms,
    lastSuccessMs: cursor.last_success_ms,
    consecutiveFailures: cursor.consecutive_failures,
    deliveredBatches: cursor.delivered_batches,
    deliveredEvents: cursor.delivered_events,
    gapReportedThroughMs: cursor.gap_reported_through_ms,
  };
}

export function toAdminPluginDto(
  plugin: PluginRow,
  eventGrants: readonly PluginEventGrantRow[],
  deliveryCursor: PluginDeliveryCursorRow | null = null,
): AdminPluginDto {
  return {
    id: plugin.id,
    name: plugin.name,
    baseUrl: plugin.base_url,
    version: plugin.version,
    protocolVersion: plugin.protocol_version,
    enabled: plugin.enabled,
    contentClass: plugin.content_class,
    grantedCapabilityTypes: plugin.granted_capability_types,
    healthState: plugin.health_state,
    consecutiveFailures: plugin.consecutive_failures,
    lastHealthCheckMs: plugin.last_health_check_ms,
    lastOkMs: plugin.last_ok_ms,
    disabledReason: plugin.disabled_reason,
    lanAllowlist: plugin.lan_allowlist,
    manifest: plugin.manifest,
    config: plugin.config,
    eventGrants: eventGrants.map(toPluginEventGrantDto),
    createdAtMs: plugin.created_at_ms,
    updatedAtMs: plugin.updated_at_ms,
    approvedAtMs: plugin.approved_at_ms,
    pseudonymizeActorIds: plugin.pseudonymize_actor_ids,
    deliveryStatus: deliveryCursor ? toPluginDeliveryStatusDto(deliveryCursor) : null,
  };
}
