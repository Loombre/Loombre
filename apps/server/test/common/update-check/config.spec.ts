// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  resolveUpdateCheckMode,
  resolveManifestBaseUrl,
  resolveUpdateCheckConfig,
  DEFAULT_MANIFEST_BASE_URL,
  UPDATE_CHECK_CHANNEL,
} from "../../../src/common/update-check/config.js";

describe("resolveUpdateCheckMode", () => {
  it("defaults to 'daily' when unset (STATE.md P4.3 resolution, see config.ts header)", () => {
    expect(resolveUpdateCheckMode(undefined)).toBe("daily");
    expect(resolveUpdateCheckMode("")).toBe("daily");
    expect(resolveUpdateCheckMode("   ")).toBe("daily");
  });

  it("accepts off/manual/daily case-insensitively, trimmed", () => {
    expect(resolveUpdateCheckMode("off")).toBe("off");
    expect(resolveUpdateCheckMode(" OFF ")).toBe("off");
    expect(resolveUpdateCheckMode("Manual")).toBe("manual");
    expect(resolveUpdateCheckMode("DAILY")).toBe("daily");
  });

  it("falls back to 'daily' on an unrecognized value rather than throwing", () => {
    expect(resolveUpdateCheckMode("weekly")).toBe("daily");
    expect(resolveUpdateCheckMode("true")).toBe("daily");
  });
});

describe("resolveManifestBaseUrl", () => {
  it("uses the documented placeholder default when unset", () => {
    expect(resolveManifestBaseUrl(undefined)).toBe(DEFAULT_MANIFEST_BASE_URL);
    expect(resolveManifestBaseUrl("")).toBe(DEFAULT_MANIFEST_BASE_URL);
  });

  it("honors an explicit override (enterprise/airgap mirror)", () => {
    expect(resolveManifestBaseUrl("https://mirror.internal/loombre/releases")).toBe(
      "https://mirror.internal/loombre/releases",
    );
  });
});

describe("resolveUpdateCheckConfig", () => {
  it("assembles the full config from env + the running version + the pinned key", () => {
    const config = resolveUpdateCheckConfig(
      { LOOMBRE_UPDATE_CHECK: "manual", LOOMBRE_UPDATE_MANIFEST_URL: "https://mirror.internal" },
      "0.9.0",
      "PUBKEY-TEXT",
    );
    expect(config).toEqual({
      mode: "manual",
      manifestBaseUrl: "https://mirror.internal",
      channel: UPDATE_CHECK_CHANNEL,
      currentVersion: "0.9.0",
      publicKeyText: "PUBKEY-TEXT",
    });
  });
});
