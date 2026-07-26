// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/scope.ts
//
// C5 seam: "content-class scoping is capability-uniform" — W3/W4's
// metadata-provider/event-subscriber integrations call THESE two functions
// as their single choke-point for "is this plugin allowed to touch this
// content".
//
// STRICT rule (tightened at Lane W3, per the mission's C5 restatement for
// PLUGINS specifically: "general-scoped plugins never receive restricted
// data through ANY capability" — a stronger requirement than
// apps/worker/src/metadata/registry.ts's assertScope, which this file
// used to mirror verbatim for BUILT-IN providers). assertPluginAttachAllowed
// now requires EXACT content-class EQUALITY, not the asymmetric rule
// registry.ts still applies to built-ins:
//
//   if (pluginContentClass !== targetContentClass) throw RestrictedPluginScopeError
//
// i.e. a 'general'-scoped plugin may ONLY attach to a 'general' target, and
// a 'restricted'-scoped plugin may ONLY attach to a 'restricted' target —
// BOTH directions are now rejected on mismatch. This is deliberately
// STRICTER than registry.ts's assertScope (which still allows a
// 'general'-scoped BUILT-IN provider to serve a 'restricted' library, e.g.
// TMDB metadata on a restricted library) — that asymmetric rule stays
// UNCHANGED for built-ins (docs/PLAN.md §6.4, registry.ts's own header);
// this file's tightening applies to PLUGINS only, because a plugin is an
// out-of-process third party a restricted library's contents must never be
// handed to just because the plugin happens to also be willing to serve
// general libraries — C5's "capability-uniform ... general-scoped plugins
// never receive restricted data through ANY capability" language is
// unconditional, not "unless the plugin also serves general libraries".
//
// `plugins.content_class` (migrations/0014_plugins.sql) is the plugin's
// computed AGGREGATE scope — see that column's comment for how the
// registration/re-approval service derives it from the plugin's GRANTED
// capabilities. These two functions only ever look at that one already-
// computed field; they never re-derive it from a manifest themselves.
// apps/worker/src/metadata/plugin-provider.ts and chain-resolution.ts
// duplicate this exact STRICT equality check (packages/db cannot import
// apps/server — the dependency graph runs the other way) as layers 2/3 of
// LPP v1's three-layer C5 defense-in-depth (write time /
// chain-resolution time / adapter-construction time); this file remains
// the canonical statement of the rule and the server-side choke-point for
// W4's own capability integration.

import type { ContentClass } from "@loombre/db";

export class RestrictedPluginScopeError extends Error {
  readonly pluginContentClass: ContentClass;
  readonly targetContentClass: ContentClass;

  constructor(pluginContentClass: ContentClass, targetContentClass: ContentClass) {
    super(
      `a '${pluginContentClass}'-scoped plugin cannot attach to a '${targetContentClass}' target ` +
        `(LPP C5 STRICT: a plugin's content_class must equal the target's content_class exactly — ` +
        `general-scoped plugins never receive restricted data through any capability, and ` +
        `restricted-scoped plugins never attach outside a restricted context)`,
    );
    this.name = "RestrictedPluginScopeError";
    this.pluginContentClass = pluginContentClass;
    this.targetContentClass = targetContentClass;
  }
}

/**
 * Throws RestrictedPluginScopeError unless `pluginContentClass` EQUALS
 * `targetContentClass` exactly (library, item, event subject, ...) — C5
 * STRICT (see this file's header): a 'general'-scoped plugin may only
 * attach to 'general' targets, a 'restricted'-scoped plugin may only
 * attach to 'restricted' targets. Both mismatch directions are rejected —
 * this is NOT the asymmetric rule apps/worker/src/metadata/registry.ts
 * still applies to built-in providers.
 */
export function assertPluginAttachAllowed(pluginContentClass: ContentClass, targetContentClass: ContentClass): void {
  if (pluginContentClass !== targetContentClass) {
    throw new RestrictedPluginScopeError(pluginContentClass, targetContentClass);
  }
}

/**
 * True iff this plugin is scoped to see restricted content at all — the
 * gate an event-subscriber delivery path (W4) checks before including a
 * restricted-content event in a plugin's batch (a 'general'-scoped
 * subscriber must never receive one, per LPP spec §4.2), and a
 * metadata-provider caller (W3) checks before routing a restricted
 * library's lookup to this plugin.
 */
export function pluginMayReceiveRestricted(plugin: { contentClass: ContentClass }): boolean {
  return plugin.contentClass === "restricted";
}
