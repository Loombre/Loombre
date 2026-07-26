// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/clearance.ts
//
// LPP v1, Lane W4, C5 clearance gating for event delivery. Two pieces:
//
//   - `pluginMayReceiveRestricted`: duplicated (not imported — apps/worker
//     cannot import apps/server, the dependency graph runs the other way,
//     the SAME "documented duplication" precedent apps/worker/src/
//     metadata/keys.ts's mirrorServerDataDir and apps/worker/src/metadata/
//     plugin-provider.ts's C5 STRICT check both already establish) from
//     apps/server/src/plugins/scope.ts's function of the same name and
//     EXACT same one-line body. That file's own header names this
//     precise function as "the gate an event-subscriber delivery path
//     (W4) checks before including a restricted-content event in a
//     plugin's batch" — i.e. this is the intended W4 integration point,
//     not scope.ts's STRICTER `assertPluginAttachAllowed` (which requires
//     EXACT content-class equality and governs capability ATTACHMENT,
//     e.g. W3's per-library provider chains — a materially different
//     question from "may a restricted-scoped subscriber also receive
//     general-content events", which this file answers unfiltered/yes,
//     matching the mission's own "restricted-scoped plugins attach only
//     to restricted contexts" read alongside C5's delivery-specific
//     wording that a GENERAL-scoped subscriber is the one-directional
//     constraint for event delivery).
//   - `buildGeneralSubscriberViewerContext`: constructs the synthetic
//     restricted-blind ViewerContext a general-scoped subscriber's
//     candidate events get run through — the ACTUAL filtering is the
//     EXISTING guard-compiled `filterEventsForViewer`
//     (packages/db/src/query/events.ts, re-exported from '@loombre/db');
//     this module never touches events or visibility logic itself, only
//     assembles the ViewerContext input that function requires (CLAUDE.md
//     invariant 4: unfiltered/reimplemented visibility logic must be
//     impossible, not discouraged).

import { listLibraries } from "@loombre/db/internal";
import type { ViewerContext, ContentClass } from "@loombre/db";
import type { createDb } from "@loombre/db";

export type DeliveryDb = ReturnType<typeof createDb>;

/**
 * True iff THIS event-subscriber CAPABILITY is scoped to see restricted
 * content — H-2 fix wave. Before this fix, the caller passed the PLUGIN's
 * aggregate `plugins.content_class` column here, which is `restricted` iff
 * ANY granted capability (not just this one) declares `contentClass:
 * "restricted"`. A completely ordinary manifest shape — a restricted-scoped
 * metadata-provider alongside a general-scoped event-subscriber wanting a
 * general activity feed — made the AGGREGATE `restricted`, which this gate
 * then read as "this subscriber may see restricted content", skipping
 * `filterEventsForViewer` ENTIRELY for a capability the admin was shown
 * (and the wizard copy explicitly stated) would "never receive activity
 * involving restricted content." C5 says "general-scoped plugins never
 * receive restricted data through ANY capability" — but the capability
 * itself, here, genuinely IS general-scoped; the sibling capability's own
 * scope must never widen this one's. The caller now passes the
 * event-subscriber CAPABILITY entry itself (its OWN `contentClass` field,
 * parsed straight off the manifest), never the plugin row.
 */
export function pluginMayReceiveRestricted(eventSubscriberCapability: { contentClass: ContentClass }): boolean {
  return eventSubscriberCapability.contentClass === "restricted";
}

/**
 * Not a real user id — filterEventsForViewer's USER_ONLY_TYPES branch
 * (restricted.locked/restricted.unlocked, packages/db/src/query/
 * events.ts) compares `payload->>'userId' = ctx.userId`; because this
 * sentinel can never equal any real users.id (UUIDv7, and this is not
 * one — a fixed all-zero-with-version-7-shape value reserved for this
 * exact purpose), a general-scoped subscriber run through this context
 * always fails that branch — a user's private lock/unlock transition is
 * not "restricted content" but is also not something any plugin receives
 * via this general-scope path (see this lane's final report's
 * open-questions section for the full discussion of this edge case).
 */
export const GENERAL_SUBSCRIBER_SENTINEL_USER_ID = "00000000-0000-7000-8000-000000000000";

/**
 * Fresh on every call (library content_class can change over time; this
 * is cheap — one unguarded, unfiltered `libraries` read, the SAME
 * boot-time-watcher-enumeration function apps/worker/src/index.ts already
 * uses) — never cached across delivery ticks, so a library reclassified
 * general->restricted (or vice versa) takes effect on the very next tick,
 * with no stale-cache leak window.
 */
export async function buildGeneralSubscriberViewerContext(db: DeliveryDb): Promise<ViewerContext> {
  const libraries = await listLibraries(db);
  const allowedLibraryIds = libraries.filter((l) => l.content_class === "general").map((l) => l.id);
  return {
    userId: GENERAL_SUBSCRIBER_SENTINEL_USER_ID,
    allowedLibraryIds,
    restrictedCleared: false,
  };
}
