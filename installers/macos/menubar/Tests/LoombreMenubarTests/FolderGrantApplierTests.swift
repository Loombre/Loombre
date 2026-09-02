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

    func testRecursiveReadGrantReachesExistingSubfoldersAndFiles() throws {
        // The rc.10 field report, pinned: a non-recursive grant left the
        // folder\u{2019}s existing contents untouched. A recursive op (the read
        // grant\u{2019}s form) must reach a nested file that predates it.
        let season = tempDir.appendingPathComponent("Season1", isDirectory: true)
        try FileManager.default.createDirectory(at: season, withIntermediateDirectories: true)
        let episode = season.appendingPathComponent("ep1.mkv")
        try Data("v".utf8).write(to: episode)
        let ace = "user:\(NSUserName()) allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit"

        // An ACE line (" 0: ") is the signal, NOT the username — `ls -l`
        // prints the owner name in the listing regardless of any ACL.
        // Non-recursive first: the nested file stays untouched.
        XCTAssertEqual(FolderGrantApplier.apply(plan([FolderGrantOperation(path: tempDir.path, ace: ace, recursive: false)])), .success)
        XCTAssertFalse(try aclEntries(of: episode.path).contains(" 0: "))

        // Recursive: the same nested file now carries the entry.
        XCTAssertEqual(FolderGrantApplier.apply(plan([FolderGrantOperation(path: tempDir.path, ace: ace, recursive: true)])), .success)
        XCTAssertTrue(try aclEntries(of: episode.path).contains(" 0: "))
        XCTAssertTrue(try aclEntries(of: episode.path).contains("readextattr"))
        XCTAssertTrue(try aclEntries(of: season.path).contains(" 0: "))
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
