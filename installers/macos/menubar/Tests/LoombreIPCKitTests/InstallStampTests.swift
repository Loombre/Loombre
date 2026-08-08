// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/InstallStampTests.swift
//
// InstallStamp.read(atPath:) reads /opt/loombre/current's OWN modification
// date — lstat semantics, never the target directory it resolves to — so
// it changes exactly when the installer recreates that symlink (every
// install/upgrade, LAYOUT.md §1's atomic swap point), not when the version
// directory it happens to point at changes. Exercised here against a real
// temp-dir symlink since the point IS the real filesystem behavior of
// FileManager.attributesOfItem(atPath:) on a symlink, not a fake.

import XCTest
@testable import LoombreIPCKit

final class InstallStampTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("InstallStampTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    /// Mirrors /opt/loombre/<version> + /opt/loombre/current: a target
    /// directory plus a symlink pointing at it.
    private func makeSymlink(target: String = "v1") throws -> String {
        let targetPath = tempDir.appendingPathComponent(target)
        try FileManager.default.createDirectory(at: targetPath, withIntermediateDirectories: true)
        let linkPath = tempDir.appendingPathComponent("current")
        try FileManager.default.createSymbolicLink(atPath: linkPath.path, withDestinationPath: targetPath.path)
        return linkPath.path
    }

    func test_read_returns_a_stamp_for_an_existing_symlink() throws {
        let linkPath = try makeSymlink()
        XCTAssertNotNil(InstallStamp.read(atPath: linkPath))
    }

    /// The whole reason this type exists: deleting and recreating the
    /// symlink — exactly what the installer does on every install/upgrade —
    /// must change the stamp, even though the target directory it resolves
    /// to (and that directory's own mtime) may not have changed at all.
    func test_read_changes_when_the_symlink_is_deleted_and_recreated() throws {
        let linkPath = try makeSymlink()
        let firstStamp = InstallStamp.read(atPath: linkPath)
        XCTAssertNotNil(firstStamp)

        // A few ms of separation guards against both symlink() calls
        // landing in the same filesystem mtime tick.
        Thread.sleep(forTimeInterval: 0.05)
        try FileManager.default.removeItem(atPath: linkPath)
        try FileManager.default.createSymbolicLink(
            atPath: linkPath,
            withDestinationPath: tempDir.appendingPathComponent("v1").path
        )

        let secondStamp = InstallStamp.read(atPath: linkPath)
        XCTAssertNotNil(secondStamp)
        XCTAssertNotEqual(firstStamp, secondStamp)
    }

    /// Dev runs outside an installed layout (no /opt/loombre/current at
    /// all) must read as nil, never crash or coerce to some other value —
    /// it's the signal AppDelegate uses to never auto-open in that case.
    func test_read_returns_nil_for_a_nonexistent_path() {
        XCTAssertNil(InstallStamp.read(atPath: tempDir.appendingPathComponent("does-not-exist").path))
    }
}
