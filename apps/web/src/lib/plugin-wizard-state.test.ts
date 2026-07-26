// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-wizard-state.test.ts

import { describe, expect, it } from "vitest";
import {
  STEP_ORDER,
  canProceedFromConfig,
  canProceedFromConfirm,
  canProceedFromGrants,
  deriveResultViewState,
  needsGrantsStep,
  nextStep,
  previousStep,
  stepIndex,
  validatePluginUrl,
  type StepId,
} from "./plugin-wizard-state.js";
import type { PluginConfigSchema } from "./plugin-manifest.js";

describe("step sequencing", () => {
  it("STEP_ORDER is url -> confirm -> config -> grants -> submitting -> result", () => {
    expect(STEP_ORDER).toEqual(["url", "confirm", "config", "grants", "submitting", "result"]);
  });

  it("nextStep advances one step and clamps at the end", () => {
    expect(nextStep("url")).toBe("confirm");
    expect(nextStep("result")).toBe("result");
  });

  it("previousStep retreats one step and clamps at the start", () => {
    expect(previousStep("confirm")).toBe("url");
    expect(previousStep("url")).toBe("url");
  });

  it("stepIndex matches STEP_ORDER position", () => {
    for (const [i, step] of STEP_ORDER.entries()) {
      expect(stepIndex(step as StepId)).toBe(i);
    }
  });
});

describe("validatePluginUrl", () => {
  it("rejects an empty entry", () => {
    expect(validatePluginUrl("")).toBeTruthy();
    expect(validatePluginUrl("   ")).toBeTruthy();
  });

  it("rejects a non-URL string", () => {
    expect(validatePluginUrl("not a url")).toBeTruthy();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(validatePluginUrl("ftp://example.invalid")).toBeTruthy();
  });

  it("accepts a well-formed http(s) URL", () => {
    expect(validatePluginUrl("http://127.0.0.1:4123")).toBeNull();
    expect(validatePluginUrl("https://plugins.example.invalid/loombre")).toBeNull();
  });
});

describe("canProceedFromConfirm", () => {
  it("requires at least one selected capability type", () => {
    expect(canProceedFromConfirm([])).toBe(false);
    expect(canProceedFromConfirm(["metadata-provider"])).toBe(true);
  });
});

const CONFIG_SCHEMA: PluginConfigSchema = {
  type: "object",
  properties: {
    fixturePrefix: { type: "string", default: "Loombre Fixture" },
    webhookUrl: { type: "string", secret: true },
  },
  required: ["webhookUrl"],
};

describe("canProceedFromConfig", () => {
  it("false while a required secret is untyped", () => {
    expect(canProceedFromConfig(CONFIG_SCHEMA, { fixturePrefix: "X" }, {})).toBe(false);
  });

  it("true once the required secret is typed and other fields are valid", () => {
    expect(canProceedFromConfig(CONFIG_SCHEMA, { fixturePrefix: "X" }, { webhookUrl: "https://example.invalid" })).toBe(true);
  });
});

describe("needsGrantsStep / canProceedFromGrants", () => {
  it("needsGrantsStep is true only when event-subscriber is among the selected types", () => {
    expect(needsGrantsStep(["metadata-provider"])).toBe(false);
    expect(needsGrantsStep(["metadata-provider", "event-subscriber"])).toBe(true);
  });

  it("canProceedFromGrants requires the granted set to be a subset of requested", () => {
    expect(canProceedFromGrants(["item.added", "playback.started"], ["item.added"])).toBe(true);
    expect(canProceedFromGrants(["item.added"], [])).toBe(true);
    expect(canProceedFromGrants(["item.added"], ["playback.started"])).toBe(false);
  });
});

describe("deriveResultViewState", () => {
  it("maps healthState to the result step's view state", () => {
    expect(deriveResultViewState("healthy")).toBe("healthy");
    expect(deriveResultViewState("unhealthy")).toBe("unhealthy-decision");
    expect(deriveResultViewState("unknown")).toBe("unknown");
  });
});
