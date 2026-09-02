// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreMenubarTests/FolderGrantApplierTests.swift
//
// Real /bin/chmod against a temporary directory. The principal is the
// CURRENT user rather than _loombre so this runs on any Mac (the service
// account only exists on an installed machine): the applier passes the
// plan's ACE through verbatim, so the principal is the plan's business.

import XCTest
import LoombreIPCKit
@testable import LoombreMenubar

final class FolderGrantApplierTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loombre-grant-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    private func plan(_ operations: [FolderGrantOperation]) -> FolderGrantPlan {
        FolderGrantPlan(scope: .read, path: operations.last!.path, operations: operations, consentTitle: "t", consentDetail: "d")
    }

    private func aclEntries(of path: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ls")
        process.arguments = ["-lde", path]
        let out = Pipe()
        process.standardOutput = out
        try process.run()
        process.waitUntilExit()
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    func testAppliesTheACEAndIsIdempotent() throws {
        let ace = "user:\(NSUserName()) allow list,search"
        let plan = plan([FolderGrantOperation(path: tempDir.path, ace: ace)])
        XCTAssertEqual(FolderGrantApplier.preflight(plan), .ok)
        XCTAssertEqual(FolderGrantApplier.apply(plan), .success)
        XCTAssertEqual(FolderGrantApplier.apply(plan), .success)
        let listing = try aclEntries(of: tempDir.path)
        XCTAssertTrue(listing.contains("allow list,search"), listing)
        // chmod +a de-duplicates identical entries: exactly one " 0: " ACE line.
        XCTAssertEqual(listing.components(separatedBy: " 0: ").count - 1, 1, listing)
        XCTAssertFalse(listing.contains(" 1: "), listing)
    }

    func testStopsAtTheFirstFailureAndReportsChmodsOwnMessage() {
        let missing = tempDir.appendingPathComponent("does-not-exist").path
        let plan = plan([
            FolderGrantOperation(path: missing, ace: "user:\(NSUserName()) allow search"),
            FolderGrantOperation(path: tempDir.path, ace: "user:\(NSUserName()) allow list,search"),
        ])
        guard case .failed(let operation, let message) = FolderGrantApplier.apply(plan) else {
            return XCTFail("expected failure")
        }
        XCTAssertEqual(operation.path, missing)
        XCTAssertTrue(message.contains("No such file"), message)
        // The second operation never ran.
        XCTAssertFalse((try? aclEntries(of: tempDir.path))?.contains("allow list,search") ?? true)
    }

    func testPreflightRefusesMissingFilesAndFoldersOwnedByOthers() throws {
        let file = tempDir.appendingPathComponent("a.mkv")
        try Data("x".utf8).write(to: file)
        XCTAssertEqual(
            FolderGrantApplier.preflight(plan([FolderGrantOperation(path: file.path, ace: "user:x allow search")])),
            .notADirectory(path: file.path)
        )
        let missing = tempDir.appendingPathComponent("nope").path
        XCTAssertEqual(
            FolderGrantApplier.preflight(plan([FolderGrantOperation(path: missing, ace: "user:x allow search")])),
            .missing(path: missing)
        )
        // /System is root-owned on every Mac; as a non-root test runner that
        // is a folder we cannot chmod. (Skipped under root, where it IS ours.)
        if getuid() != 0 {
            XCTAssertEqual(
                FolderGrantApplier.preflight(plan([FolderGrantOperation(path: "/System", ace: "user:x allow search")])),
                .notOwned(path: "/System", ownerUid: 0)
            )
        }
    }
}
