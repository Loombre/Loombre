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

    /// What "Reveal Crash Files" should DO with this response — pure data,
    /// so the empty case is a decision the UI must render (Windows-tray
    /// parity: a "No crash files found." dialog), never a silent skip.
    /// An empty list is the HEALTHY steady state — the crashes directory
    /// is created lazily on the first crash — which is precisely why the
    /// old guard-return version of this logic no-opped on every healthy
    /// install (the macOS live-test field report).
    public var revealPlan: CrashRevealPlan {
        let sorted = sortedByRecency
        return sorted.isEmpty ? .noneFound : .reveal(paths: sorted.map { $0.path })
    }
}

public enum CrashRevealPlan: Equatable {
    /// Reveal these files in Finder, most recent first.
    case reveal(paths: [String])
    /// Zero crash files on the server — tell the user so.
    case noneFound
}
