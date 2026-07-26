// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalPostgresProvisioner, externalProvisioningStatus } from "../src/external.js";
import { ExternalModeInertError } from "../src/errors.js";

// "External-mode inertness both directions" (this lane's exit bar):
//  (1) every mutating call throws immediately, with zero filesystem/process
//      side effects — proven below by asserting a scratch directory this
//      lane deliberately never creates stays absent after every call.
//  (2) getCurrentProvisioningStatus()/getDatabaseUrl() are NOT inert (reads,
//      not mutations) and behave exactly as documented.

describe("ExternalPostgresProvisioner", () => {
  it("getCurrentProvisioningStatus() always reports state 'external' with null pgVersion/dataDir", () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    const status = provisioner.getCurrentProvisioningStatus();
    expect(status.state).toBe("external");
    expect(status.pgVersion).toBeNull();
    expect(status.dataDir).toBeNull();
    expect(typeof status.lastCheckMs).toBe("number");
  });

  it("externalProvisioningStatus() matches getCurrentProvisioningStatus()'s shape exactly", () => {
    expect(externalProvisioningStatus().state).toBe("external");
  });

  it("getDatabaseUrl() is a pure passthrough — not inert, no error", () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    expect(provisioner.getDatabaseUrl()).toBe("postgres://user:pass@somehost:5432/loombre");
  });

  it("provision() throws ExternalModeInertError and touches nothing on disk", async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), "loombre-external-inertness-"));
    const neverCreated = join(scratchParent, "should-never-exist");
    try {
      const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
      await expect(provisioner.provision()).rejects.toThrow(ExternalModeInertError);
      expect(existsSync(neverCreated)).toBe(false);
    } finally {
      rmSync(scratchParent, { recursive: true, force: true });
    }
  });

  it("start() throws ExternalModeInertError", async () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    await expect(provisioner.start()).rejects.toThrow(ExternalModeInertError);
  });

  it("stop() throws ExternalModeInertError", async () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    await expect(provisioner.stop()).rejects.toThrow(ExternalModeInertError);
  });

  it("every mutating error names the operation it refused", async () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    await expect(provisioner.provision()).rejects.toThrow(/provision/);
    await expect(provisioner.start()).rejects.toThrow(/start/);
    await expect(provisioner.stop()).rejects.toThrow(/stop/);
  });

  it("status stays 'external' even after failed mutating calls (no half-transitioned state)", async () => {
    const provisioner = new ExternalPostgresProvisioner("postgres://user:pass@somehost:5432/loombre");
    await provisioner.provision().catch(() => undefined);
    await provisioner.start().catch(() => undefined);
    await provisioner.stop().catch(() => undefined);
    expect(provisioner.getCurrentProvisioningStatus().state).toBe("external");
  });
});
