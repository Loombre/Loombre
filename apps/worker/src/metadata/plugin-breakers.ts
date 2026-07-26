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
// factory runs at worker boot), matching packages/plugin-host/src/
// breaker.ts's own documented "a process restart resets this class to
// closed" tradeoff.

import { PluginCircuitBreaker } from '@loombre/plugin-host';

export interface PluginBreakerRegistry {
  /** Returns the SAME PluginCircuitBreaker instance for a given pluginId
   *  across every call for the life of this registry — constructing one
   *  with default options (LPP_BREAKER_FAILURE_THRESHOLD /
   *  LPP_BREAKER_RESET_TIMEOUT_MS) on first use. */
  getBreaker(pluginId: string): PluginCircuitBreaker;
}

export function createPluginBreakerRegistry(): PluginBreakerRegistry {
  const breakers = new Map<string, PluginCircuitBreaker>();
  return {
    getBreaker(pluginId: string): PluginCircuitBreaker {
      let breaker = breakers.get(pluginId);
      if (!breaker) {
        breaker = new PluginCircuitBreaker();
        breakers.set(pluginId, breaker);
      }
      return breaker;
    },
  };
}
