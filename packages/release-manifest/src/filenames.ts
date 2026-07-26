// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/filenames.ts
//
// The detached-signature convention (README.md "Manifest format"): the
// manifest and its minisign signature are two sibling files at a fixed
// relative naming — MANIFEST_SIGNATURE_FILENAME is always
// `${MANIFEST_FILENAME}.minisig`, never independently configurable, so a
// caller fetching one always knows the other's name.

export const MANIFEST_FILENAME = "manifest.json";
export const MANIFEST_SIGNATURE_FILENAME = "manifest.json.minisig";
