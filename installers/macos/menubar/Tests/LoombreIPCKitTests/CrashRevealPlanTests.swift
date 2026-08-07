// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKitTests/CrashRevealPlanTests.swift
//
// The macOS live-test field report behind this file: on a healthy install
// zero crashes have ever been recorded, GET /ipc/v1/crash-files correctly
// returns an empty list — and the menubar's "Reveal Crash Files" click
// did NOTHING (three silent guard-returns). The Windows tray shows a "No
// crash files found." dialog in the identical case. This pins the
// decision as pure data: an empty list is a state the UI must SPEAK
// about, never silently swallow.

import XCTest
@testable import LoombreIPCKit

final class CrashRevealPlanTests: XCTestCase {
    func testEmptyListIsNoneFoundNotASilentNoOp() {
        XCTAssertEqual(IPCCrashFilesResponse(files: []).revealPlan, .noneFound)
    }

    func testNonEmptyListRevealsPathsMostRecentFirst() {
        let response = IPCCrashFilesResponse(files: [
            IPCCrashFileEntry(path: "/Library/Application Support/Loombre/crashes/old.json", mtimeMs: 1_000),
            IPCCrashFileEntry(path: "/Library/Application Support/Loombre/crashes/new.json", mtimeMs: 2_000),
        ])
        XCTAssertEqual(
            response.revealPlan,
            .reveal(paths: [
                "/Library/Application Support/Loombre/crashes/new.json",
                "/Library/Application Support/Loombre/crashes/old.json",
            ])
        )
    }
}
