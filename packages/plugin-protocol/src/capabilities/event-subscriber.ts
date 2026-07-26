// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/capabilities/event-subscriber.ts
//
// Capability 3.2. `eventTypes` on the capability itself is a REQUEST: the
// manifest lists every outbox event type (docs/PLAN.md §4.3) the plugin
// WANTS, validated by the HOST at registration against its published
// outbox taxonomy (host-side, W2) — this package only shapes it as
// `string[]`, deliberately not a closed enum, because the taxonomy lives in
// packages/contract, not here, and LPP must not hard-couple its own
// released version to the exact outbox event set at any given moment. The
// admin GRANTS registration with possibly FEWER event types than requested
// (host decides, e.g. an admin declines to grant a restricted-content event
// type) — the granted set is host state, not part of this wire schema; a
// plugin discovers what it actually receives by inspecting each batch's
// events, never by re-reading its own manifest.
//
// `contentClass` on the capability: added per rail C5 ("Content-class
// scoping is capability-uniform") even though the mission's capability
// 3.2 field list only shows `{ type, eventTypes, delivery }` — see this
// lane's report for that call. Scopes which events reach this subscriber:
// a 'general'-scoped subscriber never receives an event whose payload
// concerns restricted-content items.
//
// Delivery mechanics (host-side, W2, documented here because they shape the
// wire): at-least-once, batched, one cursor per plugin kept by the host —
// plugins only ever ACK a batch via any 2xx response to `POST
// <delivery.endpoint>`; there is no separate ack message. A gap (plugin
// unreachable longer than the host's outbox retention window) is reported
// via `gapReport`, never silently dropped — `gapReport` is always present
// (nullable, not optional) so a typed consumer never forgets to check it.

import { z } from "zod";
import { LppContentClassSchema } from "../enums.js";

// H-5 fix wave (frozen-contract narrowing, D23) — see
// capabilities/metadata-provider.ts's identical constant for the full
// rationale (protocol-relative `//`/`/\` paths silently redirect signed
// event-delivery batches off-host).
const lppPath = z.string().regex(/^\/(?![/\\])/, { message: 'endpoint path must start with "/" and not be protocol-relative (no leading "//" or "/\\")' });

export const LppEventSubscriberDeliverySchema = z
  .object({
    endpoint: lppPath,
  })
  .strict();

export type LppEventSubscriberDelivery = z.infer<typeof LppEventSubscriberDeliverySchema>;

/** Canonical delivery path (C2). */
export const LPP_DEFAULT_EVENT_SUBSCRIBER_ENDPOINT = "/lpp/events";

export const LppEventSubscriberCapabilitySchema = z
  .object({
    type: z.literal("event-subscriber"),
    eventTypes: z.array(z.string().min(1)).min(1),
    delivery: LppEventSubscriberDeliverySchema,
    contentClass: LppContentClassSchema,
  })
  .strict();

export type LppEventSubscriberCapability = z.infer<typeof LppEventSubscriberCapabilitySchema>;

// ============================================================================
// delivery batch envelope
// ============================================================================

/** Loose UUID shape (any RFC 4122 version/variant) — ids in a delivered
 *  batch are always host-minted UUIDv7 (CLAUDE.md invariant 5) in practice,
 *  but this wire schema validates general UUID shape rather than pinning
 *  the version nibble, so a hypothetical future host id scheme change is
 *  not by itself an LPP wire break. */
const uuidLike = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const LppEventSchema = z
  .object({
    id: uuidLike,
    type: z.string().min(1),
    occurredAtMs: z.number().int().min(0),
    /** Opaque: shaped by the main API's outbox event payload schemas
     *  (packages/contract), which this package does not reproduce — it
     *  crosses the LPP wire as JSON verbatim. Actor ids inside a payload
     *  may be pseudonymized by the host (default) — subscribers MUST NOT
     *  assume any id here is a real user id. */
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type LppEvent = z.infer<typeof LppEventSchema>;

export const LppEventGapSchema = z
  .object({
    fromMs: z.number().int().min(0),
    toMs: z.number().int().min(0),
    reason: z.string().min(1),
  })
  .strict();

export type LppEventGap = z.infer<typeof LppEventGapSchema>;

export const LppGapReportSchema = z
  .object({
    detectedAtMs: z.number().int().min(0),
    gaps: z.array(LppEventGapSchema).min(1),
  })
  .strict();

export type LppGapReport = z.infer<typeof LppGapReportSchema>;

export const LppEventBatchSchema = z
  .object({
    batchId: uuidLike,
    events: z.array(LppEventSchema).min(1),
    /** Always present; null means "no gap since this plugin's last acked
     *  cursor position" (see file header — gaps are reported, never
     *  silently skipped). */
    gapReport: LppGapReportSchema.nullable(),
  })
  .strict();

export type LppEventBatch = z.infer<typeof LppEventBatchSchema>;
