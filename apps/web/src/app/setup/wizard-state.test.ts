// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/wizard-state.test.ts

import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  STEP_ORDER,
  canOfferRestore,
  decideBootRoute,
  deriveHardwareViewState,
  deriveRestoreViewState,
  deriveRestrictedViewState,
  isAdminFormValid,
  isTerminalJobStatus,
  nextStep,
  previousStep,
  stepIndex,
  validateAdminForm,
  validateLibraryForm,
  type StepId,
} from "./wizard-state.js";

describe("STEP_ORDER / nextStep / previousStep", () => {
  it("matches the task spec's literal P4.6 order", () => {
    expect(STEP_ORDER).toEqual(["welcome", "admin", "libraries", "hardware", "restricted", "restore", "done"]);
  });

  it("nextStep walks forward one step at a time", () => {
    expect(nextStep("welcome")).toBe("admin");
    expect(nextStep("admin")).toBe("libraries");
    expect(nextStep("restricted")).toBe("restore");
    expect(nextStep("restore")).toBe("done");
  });

  it("nextStep clamps at the last step (done -> done)", () => {
    expect(nextStep("done")).toBe("done");
  });

  it("previousStep walks backward one step at a time", () => {
    expect(previousStep("done")).toBe("restore");
    expect(previousStep("admin")).toBe("welcome");
  });

  it("previousStep clamps at the first step (welcome -> welcome)", () => {
    expect(previousStep("welcome")).toBe("welcome");
  });

  it("stepIndex is consistent with STEP_ORDER's own positions", () => {
    STEP_ORDER.forEach((step: StepId, i: number) => {
      expect(stepIndex(step)).toBe(i);
    });
  });
});

describe("canOfferRestore (restore-step availability gate)", () => {
  it("false before an admin exists — the wizard holds no token yet", () => {
    expect(canOfferRestore({ adminCreated: false, libraryCreatedThisSession: false })).toBe(false);
  });

  it("true once the admin exists and no library was created yet this session", () => {
    expect(canOfferRestore({ adminCreated: true, libraryCreatedThisSession: false })).toBe(true);
  });

  it("false once a library was created this session (POST /import would fail-if-not-empty)", () => {
    expect(canOfferRestore({ adminCreated: true, libraryCreatedThisSession: true })).toBe(false);
  });
});

describe("validateAdminForm / isAdminFormValid (mirrors FirstAdminRequest)", () => {
  const valid = { username: "alice", email: "alice@example.com", password: "correct-horse-battery" };

  it("a fully valid form has no errors", () => {
    expect(validateAdminForm(valid)).toEqual({});
    expect(isAdminFormValid(valid)).toBe(true);
  });

  it("empty username is rejected", () => {
    const errors = validateAdminForm({ ...valid, username: "  " });
    expect(errors.username).toBeDefined();
    expect(isAdminFormValid({ ...valid, username: "  " })).toBe(false);
  });

  it("empty email is rejected", () => {
    expect(validateAdminForm({ ...valid, email: "" }).email).toBeDefined();
  });

  it("malformed email is rejected", () => {
    expect(validateAdminForm({ ...valid, email: "not-an-email" }).email).toBeDefined();
  });

  it(`password shorter than ${MIN_PASSWORD_LENGTH} chars is rejected (contract minLength)`, () => {
    const errors = validateAdminForm({ ...valid, password: "short1" });
    expect(errors.password).toBeDefined();
  });

  it(`password exactly ${MIN_PASSWORD_LENGTH} chars is accepted`, () => {
    const errors = validateAdminForm({ ...valid, password: "12345678" });
    expect(errors.password).toBeUndefined();
  });

  it("reports all three errors simultaneously when everything is invalid", () => {
    const errors = validateAdminForm({ username: "", email: "", password: "" });
    expect(Object.keys(errors).sort()).toEqual(["email", "password", "username"]);
  });
});

describe("validateLibraryForm (manual path entry — P4.6 folder-picker deviation)", () => {
  it("valid with a name and at least one non-blank path", () => {
    expect(validateLibraryForm({ name: "Movies", paths: ["/mnt/media/movies"] })).toEqual({});
  });

  it("empty name is rejected", () => {
    expect(validateLibraryForm({ name: "", paths: ["/x"] }).name).toBeDefined();
  });

  it("zero paths is rejected", () => {
    expect(validateLibraryForm({ name: "Movies", paths: [] }).paths).toBeDefined();
  });

  it("all-blank paths is rejected (not just an empty array)", () => {
    expect(validateLibraryForm({ name: "Movies", paths: ["", "   "] }).paths).toBeDefined();
  });
});

describe("isTerminalJobStatus (restore-step job polling)", () => {
  it("queued/active are non-terminal", () => {
    expect(isTerminalJobStatus("queued")).toBe(false);
    expect(isTerminalJobStatus("active")).toBe(false);
  });

  it("completed/failed/cancelled are terminal", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
  });
});

describe("deriveHardwareViewState (hardware-probe step rendering)", () => {
  it("null report -> empty (worker not detected yet)", () => {
    expect(deriveHardwareViewState(null)).toBe("empty");
  });

  it("a report object -> ready", () => {
    expect(deriveHardwareViewState({ platform: "macos", backends: [] })).toBe("ready");
  });
});

describe("deriveRestrictedViewState (restricted-content step rendering)", () => {
  it("instance capability off -> capability-off (informational, P1.19 env explanation)", () => {
    expect(deriveRestrictedViewState(false)).toBe("capability-off");
  });

  it("instance capability on -> opt-in-form", () => {
    expect(deriveRestrictedViewState(true)).toBe("opt-in-form");
  });
});

describe("deriveRestoreViewState (restore step rendering)", () => {
  const emptyFlags = { adminCreated: true, libraryCreatedThisSession: false };
  const blockedFlags = { adminCreated: true, libraryCreatedThisSession: true };

  it("no job yet, restore offerable -> offer", () => {
    expect(deriveRestoreViewState(emptyFlags, null)).toBe("offer");
  });

  it("no job yet, a library was already created this session -> blocked-library-created", () => {
    expect(deriveRestoreViewState(blockedFlags, null)).toBe("blocked-library-created");
  });

  it("job queued/active -> polling", () => {
    expect(deriveRestoreViewState(emptyFlags, { status: "queued", lastError: null })).toBe("polling");
    expect(deriveRestoreViewState(emptyFlags, { status: "active", lastError: null })).toBe("polling");
  });

  it("job completed -> succeeded", () => {
    expect(deriveRestoreViewState(emptyFlags, { status: "completed", lastError: null })).toBe("succeeded");
  });

  it("job failed or cancelled -> failed", () => {
    expect(deriveRestoreViewState(emptyFlags, { status: "failed", lastError: "boom" })).toBe("failed");
    expect(deriveRestoreViewState(emptyFlags, { status: "cancelled", lastError: null })).toBe("failed");
  });

  it("an in-flight job takes priority over the library-created block (a job already started; don't relabel it)", () => {
    expect(deriveRestoreViewState(blockedFlags, { status: "active", lastError: null })).toBe("polling");
  });
});

describe("decideBootRoute (apps/web/src/app/page.tsx boot wiring)", () => {
  it("authenticated always wins -> /home, regardless of needsSetup", () => {
    expect(decideBootRoute({ isAuthenticated: true, needsSetup: true })).toBe("/home");
    expect(decideBootRoute({ isAuthenticated: true, needsSetup: false })).toBe("/home");
  });

  it("unauthenticated + needsSetup -> /setup", () => {
    expect(decideBootRoute({ isAuthenticated: false, needsSetup: true })).toBe("/setup");
  });

  it("unauthenticated + configured instance -> /login (never flashes the wizard)", () => {
    expect(decideBootRoute({ isAuthenticated: false, needsSetup: false })).toBe("/login");
  });
});
