// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/manifest.ts
//
// The release manifest format (P4.3). The server's notify-only update
// check fetches this (plus its detached minisign signature, see
// filenames.ts and minisign/verify.ts) and never auto-applies anything —
// this package models the DATA the server reads, not the check itself.

export const RELEASE_MANIFEST_VERSION = 1 as const;

/** Single-member closed literal today — additive contract evolution
 *  (docs/PLAN.md §4.1) is how a future channel gets added. */
export type ReleaseChannel = "stable";

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["stable"];

export type ArtifactPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "macos-arm64"
  | "macos-x64"
  | "docker";

export const ARTIFACT_PLATFORMS: readonly ArtifactPlatform[] = [
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "macos-arm64",
  "macos-x64",
  "docker",
];

/** "bundle" is the Windows Burn BOOTSTRAPPER (.exe) — distinct from "msi"
 *  on purpose. They are two different installable units of the same
 *  release: the bundle detects and installs the Visual C++ redistributable
 *  prerequisite and then runs the MSI, while the bare MSI is for managed
 *  deployment and refuses to install without that prerequisite already
 *  present. A download page or updater must be able to tell them apart to
 *  recommend the right one, which a shared kind would prevent. */
export type ArtifactKind = "tarball" | "msi" | "bundle" | "pkg" | "docker-image" | "checksums-file";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "tarball",
  "msi",
  "bundle",
  "pkg",
  "docker-image",
  "checksums-file",
];

export interface ReleaseArtifact {
  platform: ArtifactPlatform;
  kind: ArtifactKind;
  filename: string;
  sizeBytes: number;
  /** Lowercase 64-char hex SHA-256 of the artifact bytes. */
  sha256: string;
  url: string;
}

export interface ReleaseEntry {
  /** semver, e.g. "1.2.0". */
  version: string;
  releasedAtMs: number;
  notesUrl: string;
  artifacts: ReleaseArtifact[];
}

export interface ReleaseManifest {
  manifestVersion: typeof RELEASE_MANIFEST_VERSION;
  channel: ReleaseChannel;
  releases: ReleaseEntry[];
}

// semver.org's own suggested regex (release + optional prerelease/build
// metadata), used verbatim rather than reinvented.
const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?" +
  "(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$";

const SHA256_PATTERN = "^[0-9a-f]{64}$";

export const RELEASE_ARTIFACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "kind", "filename", "sizeBytes", "sha256", "url"],
  properties: {
    platform: { type: "string", enum: [...ARTIFACT_PLATFORMS] },
    kind: { type: "string", enum: [...ARTIFACT_KINDS] },
    filename: { type: "string", minLength: 1 },
    sizeBytes: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: SHA256_PATTERN },
    url: { type: "string", minLength: 1 },
  },
} as const;

export const RELEASE_ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "releasedAtMs", "notesUrl", "artifacts"],
  properties: {
    version: { type: "string", pattern: SEMVER_PATTERN },
    releasedAtMs: { type: "integer", minimum: 0 },
    notesUrl: { type: "string", minLength: 1 },
    artifacts: { type: "array", items: RELEASE_ARTIFACT_SCHEMA },
  },
} as const;

export const RELEASE_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["manifestVersion", "channel", "releases"],
  properties: {
    manifestVersion: { const: RELEASE_MANIFEST_VERSION },
    channel: { type: "string", enum: [...RELEASE_CHANNELS] },
    releases: { type: "array", items: RELEASE_ENTRY_SCHEMA },
  },
} as const;
