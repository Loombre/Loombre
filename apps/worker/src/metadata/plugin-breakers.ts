// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/plugin-breakers.ts
//
// LPP v1 (Lane W3), mission point 1: "instantiate PluginCircuitBreaker per
// plugin in the worker process (in-memory per-process is the documented
// W2 tradeoff)". A `PluginCircuitBreaker` only means anything if the SAME
// instance persists across every call to the SAME plugin for the lifetime
// of the worker process — chain resolution itself re-reads the DB fresh
// on every job (apps/worker/src/metadata/chain-resolution.ts), so this
// tiny per-process registry is the one piece of LPP v1 metadata-provider
// state in apps/worker that deliberately does NOT get reconstructed per
// job. `metadataConsumerHandler` (consumer.ts) owns exactly one instance
// of this registry for its own lifetime (constructed once when the
// factory runs at worker boot).
//
// C5.1 fix wave (closes deferred LPP L-5, worker-side — mirrors
// apps/server/src/plugins/plugin-health.service.ts's identical fix):
// `getBreaker` now accepts an optional `seed` (typically
// `plugins.consecutive_failures`, read fresh by the caller right before
// this call — see chain-resolution.ts), forwarded only on a given
// pluginId's FIRST construction in this registry's lifetime — effectively
// "at boot" for this lazily-constructed registry. Closes the cross-process
// gap: apps/server's periodic health check writes the SAME durable column
// on its own cadence, so a worker process that has never called a given
// plugin yet must not construct a breaker blind to failures another
// process already recorded there.

import { PluginCircuitBreaker, type PluginBreakerSeed } from '@loombre/plugin-host';

export interface PluginBreakerRegistry {
  /** Returns the SAME PluginCircuitBreaker instance for a given pluginId
   *  across every call for the life of this registry — constructing one
   *  with default options (LPP_BREAKER_FAILURE_THRESHOLD /
   *  LPP_BREAKER_RESET_TIMEOUT_MS), seeded from `seed` if given, on first
   *  use. `seed` is ignored on every call after the first for a given
   *  pluginId (the existing instance is returned as-is). */
  getBreaker(pluginId: string, seed?: PluginBreakerSeed): PluginCircuitBreaker;
}

export function createPluginBreakerRegistry(): PluginBreakerRegistry {
  const breakers = new Map<string, PluginCircuitBreaker>();
  return {
    getBreaker(pluginId: string, seed?: PluginBreakerSeed): PluginCircuitBreaker {
      let breaker = breakers.get(pluginId);
      if (!breaker) {
        breaker = new PluginCircuitBreaker(seed ? { seed } : {});
        breakers.set(pluginId, breaker);
      }
      return breaker;
    },
  };
}
