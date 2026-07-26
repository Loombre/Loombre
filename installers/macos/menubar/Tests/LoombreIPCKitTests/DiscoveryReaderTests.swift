// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/DiscoveryReaderTests.swift
//
// Exercises DiscoveryReader.resolve(...) — the pure core — against
// Fixtures.discoveryFile, with an injected ProcessLivenessChecking fake so
// no real pid/process state is involved. load() (real file I/O) is
// intentionally NOT covered here — see the class header for why.

import XCTest
@testable import LoombreIPCKit

private struct FakeLivenessChecker: ProcessLivenessChecking {
    let alivePids: Set<Int32>
    func isRunning(pid: Int32) -> Bool { alivePids.contains(pid) }
}

final class DiscoveryReaderTests: XCTestCase {
    func test_resolve_succeeds_when_pid_is_alive() throws {
        let discoveryData = Fixtures.discoveryFile.data(using: .utf8)!
        let connection = try DiscoveryReader.resolve(
            discoveryData: discoveryData,
            tokenText: "sekrit-token",
            checker: FakeLivenessChecker(alivePids: [4242])
        )
        XCTAssertEqual(connection.token, "sekrit-token")
        XCTAssertEqual(connection.discovery.pid, 4242)
        XCTAssertEqual(connection.baseURL.absoluteString, "http://127.0.0.1:54217/ipc/v1")
    }

    func test_resolve_trims_exactly_one_trailing_newline_from_token() throws {
        let discoveryData = Fixtures.discoveryFile.data(using: .utf8)!
        let connection = try DiscoveryReader.resolve(
            discoveryData: discoveryData,
            tokenText: "sekrit-token\n",
            checker: FakeLivenessChecker(alivePids: [4242])
        )
        XCTAssertEqual(connection.token, "sekrit-token")
    }

    func test_resolve_does_not_trim_internal_whitespace_or_multiple_newlines() throws {
        let discoveryData = Fixtures.discoveryFile.data(using: .utf8)!
        let connection = try DiscoveryReader.resolve(
            discoveryData: discoveryData,
            tokenText: "sekrit-token\n\n",
            checker: FakeLivenessChecker(alivePids: [4242])
        )
        // Only ONE trailing newline is stripped — the token is opaque
        // beyond that, per transport.ts's "no trailing newline required"
        // (not "trim all trailing whitespace").
        XCTAssertEqual(connection.token, "sekrit-token\n")
    }

    func test_resolve_throws_staleProcess_when_pid_is_not_alive() {
        let discoveryData = Fixtures.discoveryFile.data(using: .utf8)!
        XCTAssertThrowsError(
            try DiscoveryReader.resolve(
                discoveryData: discoveryData,
                tokenText: "sekrit-token",
                checker: FakeLivenessChecker(alivePids: [])
            )
        ) { error in
            XCTAssertEqual(error as? DiscoveryError, .staleProcess(pid: 4242))
        }
    }

    func test_resolve_throws_on_malformed_discovery_json() {
        let discoveryData = "{ not json".data(using: .utf8)!
        XCTAssertThrowsError(
            try DiscoveryReader.resolve(
                discoveryData: discoveryData,
                tokenText: "sekrit-token",
                checker: FakeLivenessChecker(alivePids: [4242])
            )
        )
    }
}
