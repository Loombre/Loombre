// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/test/type-agreement.spec.ts — see
// packages/provisioning/test/type-agreement.spec.ts for the full rationale.

import { describe, expect, it, expectTypeOf } from "vitest";

import {
  RELEASE_CHANNELS,
  ARTIFACT_PLATFORMS,
  ARTIFACT_KINDS,
  RELEASE_MANIFEST_SCHEMA,
  type ReleaseChannel,
  type ArtifactPlatform,
  type ArtifactKind,
} from "../src/manifest.js";
import {
  MANIFEST_VERIFICATION_FAILURE_REASONS,
  type ManifestVerificationFailureReason,
  type ManifestVerificationResult,
} from "../src/minisign/types.js";

describe("closed-enum agreement: TS union types vs runtime arrays", () => {
  it("ReleaseChannel === (typeof RELEASE_CHANNELS)[number]", () => {
    expectTypeOf<(typeof RELEASE_CHANNELS)[number]>().toEqualTypeOf<ReleaseChannel>();
  });

  it("ArtifactPlatform === (typeof ARTIFACT_PLATFORMS)[number]", () => {
    expectTypeOf<(typeof ARTIFACT_PLATFORMS)[number]>().toEqualTypeOf<ArtifactPlatform>();
  });

  it("ArtifactKind === (typeof ARTIFACT_KINDS)[number]", () => {
    expectTypeOf<(typeof ARTIFACT_KINDS)[number]>().toEqualTypeOf<ArtifactKind>();
  });

  it("ManifestVerificationFailureReason === (typeof MANIFEST_VERIFICATION_FAILURE_REASONS)[number]", () => {
    expectTypeOf<(typeof MANIFEST_VERIFICATION_FAILURE_REASONS)[number]>().toEqualTypeOf<ManifestVerificationFailureReason>();
  });
});

describe("closed-enum agreement: runtime arrays vs the schema's own enum fields", () => {
  it("RELEASE_MANIFEST_SCHEMA.properties.channel.enum === RELEASE_CHANNELS", () => {
    expect(RELEASE_MANIFEST_SCHEMA.properties.channel.enum).toEqual(RELEASE_CHANNELS);
  });

  it("the artifact schema's platform/kind enums === ARTIFACT_PLATFORMS / ARTIFACT_KINDS", () => {
    const artifactSchema = RELEASE_MANIFEST_SCHEMA.properties.releases.items.properties.artifacts.items;
    expect(artifactSchema.properties.platform.enum).toEqual(ARTIFACT_PLATFORMS);
    expect(artifactSchema.properties.kind.enum).toEqual(ARTIFACT_KINDS);
  });
});

describe("closed-enum agreement: TS rejects out-of-enum literals (compile-time)", () => {
  it("ArtifactPlatform rejects a non-member string literal", () => {
    // @ts-expect-error 'freebsd-x64' is not a member of ArtifactPlatform.
    const bad: ArtifactPlatform = "freebsd-x64";
    void bad;
    expect(true).toBe(true);
  });

  it("ManifestVerificationResult's failure reason rejects a prose-shaped string", () => {
    // @ts-expect-error prose is never a valid ManifestVerificationFailureReason.
    const bad: ManifestVerificationResult = { valid: false, reason: "the moon is full" };
    void bad;
    expect(true).toBe(true);
  });
});
