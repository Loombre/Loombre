// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/index.ts — package-local barrel.
//
// LPP v1, Lane W4. Narrow, deliberate surface for apps/worker/src/index.ts
// to wire up: starting/stopping the loop and the constants an
// operator/health surface might want to display. Everything else in this
// directory (keyring/manifest/clearance helpers, the actor-field map, the
// gap/backoff math) is an implementation detail reached through here, not
// imported directly by index.ts.

export {
  deliverOnePluginTick,
  startPluginDeliveryLoop,
  type DeliveryTickOutcome,
  type PluginDeliveryLoopDeps,
  type PluginDeliveryLoopHandle,
} from "./delivery-loop.js";
export {
  LPP_DELIVERY_BATCH_MAX,
  LPP_DELIVERY_POLL_INTERVAL_MS,
  LPP_DELIVERY_RETENTION_WINDOW_MS,
  LPP_DELIVERY_TIMEOUT_MS,
} from "./constants.js";
