// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/scope.spec.ts
//
// C5 STRICT: assertPluginAttachAllowed / pluginMayReceiveRestricted, both
// directions — Lane W3 tightened assertPluginAttachAllowed to EXACT
// content-class equality (unlike apps/worker/src/metadata/registry.ts's
// assertScope, which stays asymmetric for BUILT-IN providers: restricted
// => restricted-only, general => both). This is a leak-suite-style case
// set for layer 1 of LPP v1's three-layer C5 defense-in-depth (the other
// two layers — chain-resolution time, adapter-construction time — are
// covered by apps/worker/test/metadata/chain-resolution.spec.ts and
// plugin-provider.spec.ts).

import { describe, expect, it } from "vitest";
import { assertPluginAttachAllowed, pluginMayReceiveRestricted, RestrictedPluginScopeError } from "./scope.js";

describe("assertPluginAttachAllowed (C5 STRICT — exact content-class equality)", () => {
  it("throws when a restricted-scoped plugin attaches to a general target", () => {
    expect(() => assertPluginAttachAllowed("restricted", "general")).toThrow(RestrictedPluginScopeError);
  });

  it("allows a restricted-scoped plugin to attach to a restricted target", () => {
    expect(() => assertPluginAttachAllowed("restricted", "restricted")).not.toThrow();
  });

  it("allows a general-scoped plugin to attach to a general target", () => {
    expect(() => assertPluginAttachAllowed("general", "general")).not.toThrow();
  });

  it("STRICT (unlike the built-in registry's asymmetric rule): throws when a general-scoped plugin attaches to a restricted target — a general-scoped plugin must never receive restricted data through any capability", () => {
    expect(() => assertPluginAttachAllowed("general", "restricted")).toThrow(RestrictedPluginScopeError);
  });

  it("the thrown error carries both content classes, restricted-attaches-to-general direction", () => {
    try {
      assertPluginAttachAllowed("restricted", "general");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RestrictedPluginScopeError);
      const scopeErr = err as RestrictedPluginScopeError;
      expect(scopeErr.pluginContentClass).toBe("restricted");
      expect(scopeErr.targetContentClass).toBe("general");
    }
  });

  it("the thrown error carries both content classes, general-attaches-to-restricted direction (the case STRICT newly rejects)", () => {
    try {
      assertPluginAttachAllowed("general", "restricted");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RestrictedPluginScopeError);
      const scopeErr = err as RestrictedPluginScopeError;
      expect(scopeErr.pluginContentClass).toBe("general");
      expect(scopeErr.targetContentClass).toBe("restricted");
    }
  });
});

describe("pluginMayReceiveRestricted", () => {
  it("is true for a restricted-scoped plugin", () => {
    expect(pluginMayReceiveRestricted({ contentClass: "restricted" })).toBe(true);
  });

  it("is false for a general-scoped plugin", () => {
    expect(pluginMayReceiveRestricted({ contentClass: "general" })).toBe(false);
  });
});
