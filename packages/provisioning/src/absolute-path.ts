// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/absolute-path.ts
//
// Shape-only absolute-path validation shared by every field in this
// package that carries a filesystem path (ProvisioningRequest.dataDir,
// UpgradePlan.backupPath, CorruptionReport.dataDir). Deliberately loose
// beyond "is this absolute": platform-correct app-data base resolution
// (XDG / %ProgramData% / ~/Library/Application Support, docs/PLAN.md §11)
// is explicitly the CALLER's concern, and this interface performs no I/O
// (no fs.existsSync, nothing) — this is a wire-shape check only, matched
// against POSIX absolute paths, Windows drive-letter paths, and Windows
// UNC paths.

export const ABSOLUTE_PATH_PATTERN = "^(/|[A-Za-z]:[\\\\/]|\\\\\\\\)";
