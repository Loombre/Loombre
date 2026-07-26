// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compile } from "./ajv-helper.js";
import {
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_MANIFEST_VERSION,
  ARTIFACT_PLATFORMS,
  ARTIFACT_KINDS,
  type ReleaseManifest,
} from "../src/manifest.js";

function baseFixture(): ReleaseManifest {
  return {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    channel: "stable",
    releases: [
      {
        version: "1.2.0",
        releasedAtMs: 1_753_315_200_000,
        notesUrl: "https://example.invalid/releases/1.2.0",
        artifacts: [
          {
            platform: "linux-x64",
            kind: "tarball",
            filename: "loombre-1.2.0-linux-x64.tar.gz",
            sizeBytes: 123_456_789,
            sha256: "a".repeat(64),
            url: "https://example.invalid/releases/1.2.0/loombre-1.2.0-linux-x64.tar.gz",
          },
        ],
      },
    ],
  } satisfies ReleaseManifest;
}

describe("RELEASE_MANIFEST_SCHEMA", () => {
  const validate = compile(RELEASE_MANIFEST_SCHEMA);

  it("accepts a well-formed manifest", () => {
    expect(validate(baseFixture()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts every closed artifact platform x kind combination", () => {
    for (const platform of ARTIFACT_PLATFORMS) {
      for (const kind of ARTIFACT_KINDS) {
        const fixture = baseFixture();
        fixture.releases[0]!.artifacts = [
          {
            platform,
            kind,
            filename: "x",
            sizeBytes: 0,
            sha256: "0".repeat(64),
            url: "https://example.invalid/x",
          },
        ];
        expect(validate(fixture), `${platform}/${kind}: ${JSON.stringify(validate.errors)}`).toBe(
          true,
        );
      }
    }
  });

  it("accepts an empty releases array (freshly-initialized channel)", () => {
    expect(validate({ ...baseFixture(), releases: [] })).toBe(true);
  });

  it("rejects a manifestVersion other than 1", () => {
    expect(validate({ ...baseFixture(), manifestVersion: 2 })).toBe(false);
  });

  it("rejects a channel outside the closed enum", () => {
    expect(validate({ ...baseFixture(), channel: "beta" })).toBe(false);
  });

  it("rejects a platform outside the closed enum", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.artifacts[0]!.platform = "freebsd-x64" as never;
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a kind outside the closed enum", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.artifacts[0]!.kind = "zip" as never;
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a malformed semver version", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.version = "1.2";
    expect(validate(fixture)).toBe(false);
  });

  it("accepts a semver with prerelease + build metadata", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.version = "1.2.0-rc.1+build.42";
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a non-64-char sha256", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.artifacts[0]!.sha256 = "abc123";
    expect(validate(fixture)).toBe(false);
  });

  it("rejects an uppercase sha256 (lowercase-only convention)", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.artifacts[0]!.sha256 = "A".repeat(64);
    expect(validate(fixture)).toBe(false);
  });

  it("rejects a negative sizeBytes", () => {
    const fixture = baseFixture();
    fixture.releases[0]!.artifacts[0]!.sizeBytes = -1;
    expect(validate(fixture)).toBe(false);
  });

  it("rejects an extra unexpected top-level property", () => {
    expect(validate({ ...baseFixture(), signedBy: "owner" })).toBe(false);
  });
});
