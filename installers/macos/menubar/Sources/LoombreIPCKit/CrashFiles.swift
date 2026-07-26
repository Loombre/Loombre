// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/CrashFiles.swift
//
// Mirrors packages/controller-ipc/src/crash-files.ts — GET
// /ipc/v1/crash-files. Backs the menubar's "Reveal in folder" menu item
// (AppDelegate.swift, via NSWorkspace.shared.activateFileViewerSelecting).

import Foundation

public struct IPCCrashFileEntry: Codable, Equatable {
    public let path: String
    public let mtimeMs: Int64

    public init(path: String, mtimeMs: Int64) {
        self.path = path
        self.mtimeMs = mtimeMs
    }
}

public struct IPCCrashFilesResponse: Codable, Equatable {
    public let files: [IPCCrashFileEntry]

    public init(files: [IPCCrashFileEntry]) {
        self.files = files
    }
}

extension IPCCrashFilesResponse {
    /// Sorted by recency, most recent first — the natural order for a
    /// "reveal in folder"-style list. Pure, so it's directly unit-testable
    /// without touching NSWorkspace.
    public var sortedByRecency: [IPCCrashFileEntry] {
        files.sorted { $0.mtimeMs > $1.mtimeMs }
    }
}
