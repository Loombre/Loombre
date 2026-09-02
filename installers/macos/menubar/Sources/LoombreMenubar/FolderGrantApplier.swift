// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubar/FolderGrantApplier.swift
//
// Applies a consented FolderGrantPlan by running /bin/chmod +a — the
// documented recipe, verbatim, as the signed-in user. No shell (argv
// array), no privileges: macOS lets a folder's owner add ACL entries, which
// is exactly why this app can do what the browser and the daemon cannot.
// `chmod +a` never duplicates an identical entry, so re-consenting is
// harmless.

import Foundation
import LoombreIPCKit

enum FolderGrantApplier {
    enum Preflight: Equatable {
        case ok
        case missing(path: String)
        case notADirectory(path: String)
        /// chmod +a requires ownership; a folder on an external drive with
        /// "ignore ownership" on reports the current user, so this only
        /// fires where the grant genuinely cannot be made.
        case notOwned(path: String, ownerUid: uid_t)
    }

    enum Outcome: Equatable {
        case success
        case failed(operation: FolderGrantOperation, message: String)
    }

    /// Every operation's target must exist, be a directory, and be owned by
    /// the current user — checked BEFORE the consent dialog so the user is
    /// never asked to allow something that then fails.
    static func preflight(_ plan: FolderGrantPlan, fileManager: FileManager = .default, uid: uid_t = getuid()) -> Preflight {
        for operation in plan.operations {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: operation.path, isDirectory: &isDirectory) else {
                return .missing(path: operation.path)
            }
            guard isDirectory.boolValue else {
                return .notADirectory(path: operation.path)
            }
            guard let attributes = try? fileManager.attributesOfItem(atPath: operation.path),
                  let owner = attributes[.ownerAccountID] as? NSNumber else {
                continue
            }
            if owner.uint32Value != uid {
                return .notOwned(path: operation.path, ownerUid: owner.uint32Value)
            }
        }
        return .ok
    }

    /// Runs the operations in order, stopping at the first failure — the
    /// remaining ones would only produce a half-consented state.
    static func apply(_ plan: FolderGrantPlan, chmod: URL = URL(fileURLWithPath: "/bin/chmod")) -> Outcome {
        for operation in plan.operations {
            let process = Process()
            process.executableURL = chmod
            process.arguments = operation.chmodArguments
            let stderr = Pipe()
            process.standardError = stderr
            process.standardOutput = FileHandle.nullDevice
            do {
                try process.run()
            } catch {
                return .failed(operation: operation, message: error.localizedDescription)
            }
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                let data = stderr.fileHandleForReading.readDataToEndOfFile()
                let message = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                return .failed(operation: operation, message: message.isEmpty ? "chmod exited with status \(process.terminationStatus)" : message)
            }
        }
        return .success
    }
}
