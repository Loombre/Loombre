// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/CodableRoundTripTests.swift
//
// Proves every LoombreIPCKit type decodes the contract's real fixture
// VALUES (Fixtures.swift, copied from fixtures.json, validated against
// @loombre/controller-ipc + @loombre/provisioning's Ajv schemas by
// verify-fixtures.mjs) and re-encodes/re-decodes losslessly.

import XCTest
@testable import LoombreIPCKit

final class CodableRoundTripTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, from json: String, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        let data = json.data(using: .utf8)!
        let decoded = try decoder.decode(T.self, from: data)
        let reencoded = try encoder.encode(decoded)
        let redecoded = try decoder.decode(T.self, from: reencoded)
        XCTAssertEqual(decoded, redecoded, "round-trip through encode/decode changed the value", file: file, line: line)
        return decoded
    }

    func test_discoveryFile() throws {
        let value = try roundTrip(IPCDiscoveryFile.self, from: Fixtures.discoveryFile)
        XCTAssertEqual(value.port, 54217)
        XCTAssertEqual(value.host, "127.0.0.1")
        XCTAssertEqual(value.pid, 4242)
        XCTAssertEqual(value.startedAtMs, 1_732_400_000_000)
    }

    func test_discoveryFile_decodeHelper_accepts_valid_host() throws {
        let data = Fixtures.discoveryFile.data(using: .utf8)!
        let value = try IPCDiscoveryFile.decode(data)
        XCTAssertEqual(value.host, "127.0.0.1")
    }

    func test_discoveryFile_decodeHelper_rejects_wrong_host() {
        let tampered = Fixtures.discoveryFile.replacingOccurrences(of: "127.0.0.1", with: "0.0.0.0")
        let data = tampered.data(using: .utf8)!
        XCTAssertThrowsError(try IPCDiscoveryFile.decode(data)) { error in
            XCTAssertEqual(error as? IPCDiscoveryFileError, .unexpectedHost("0.0.0.0"))
        }
    }

    func test_processInfo_running() throws {
        let value = try roundTrip(IPCProcessInfo.self, from: Fixtures.processInfoRunning)
        XCTAssertEqual(value.state, .running)
        XCTAssertEqual(value.pid, 4242)
        XCTAssertEqual(value.version, "0.0.1")
    }

    func test_processInfo_stopped_has_nil_pid_and_startedAt() throws {
        let value = try roundTrip(IPCProcessInfo.self, from: Fixtures.processInfoStopped)
        XCTAssertEqual(value.state, .stopped)
        XCTAssertNil(value.pid)
        XCTAssertNil(value.startedAtMs)
    }

    func test_processInfo_crashed_has_nil_pid_but_retains_startedAt() throws {
        let value = try roundTrip(IPCProcessInfo.self, from: Fixtures.processInfoCrashed)
        XCTAssertEqual(value.state, .crashed)
        XCTAssertNil(value.pid)
        XCTAssertEqual(value.startedAtMs, 1_732_400_000_000)
    }

    func test_provisioningStatus_external_has_nil_pgVersion_and_dataDir() throws {
        let value = try roundTrip(ProvisioningStatus.self, from: Fixtures.provisioningStatusExternal)
        XCTAssertEqual(value.state, .external)
        XCTAssertNil(value.pgVersion)
        XCTAssertNil(value.dataDir)
        XCTAssertNil(value.detail)
    }

    func test_provisioningStatus_ready_carries_detail() throws {
        let value = try roundTrip(ProvisioningStatus.self, from: Fixtures.provisioningStatusReady)
        XCTAssertEqual(value.state, .ready)
        XCTAssertEqual(value.pgVersion, "17.4")
        XCTAssertEqual(value.detail, "ok")
    }

    func test_statusResponse_healthy() throws {
        let value = try roundTrip(IPCStatusResponse.self, from: Fixtures.statusResponseHealthy)
        XCTAssertEqual(value.ipcContractVersion, 1)
        XCTAssertEqual(value.server.state, .running)
        XCTAssertEqual(value.worker.state, .running)
        XCTAssertEqual(value.webUrl, "http://localhost:3001")
        XCTAssertEqual(value.provisioning.state, .external)
        XCTAssertTrue(value.matchesClientContractVersion)
    }

    func test_statusResponse_stopped_has_nil_webUrl() throws {
        let value = try roundTrip(IPCStatusResponse.self, from: Fixtures.statusResponseStopped)
        XCTAssertNil(value.webUrl)
        XCTAssertEqual(value.server.state, .stopped)
    }

    func test_statusResponse_crashed_carries_corruption_detail() throws {
        let value = try roundTrip(IPCStatusResponse.self, from: Fixtures.statusResponseCrashed)
        XCTAssertEqual(value.server.state, .crashed)
        XCTAssertEqual(value.provisioning.state, .corrupt)
        XCTAssertEqual(value.provisioning.detail, "checksum-failure")
    }

    func test_statusResponse_contractMismatch_is_flagged() throws {
        let value = try roundTrip(IPCStatusResponse.self, from: Fixtures.statusResponseContractMismatch)
        XCTAssertEqual(value.ipcContractVersion, 2)
        XCTAssertFalse(value.matchesClientContractVersion)
    }

    func test_errorBody_unauthorized() throws {
        let value = try roundTrip(IPCErrorBody.self, from: Fixtures.errorBodyUnauthorized)
        XCTAssertEqual(value.code, .unauthorized)
        XCTAssertEqual(value.status, 401)
        XCTAssertEqual(value.detail, "Bearer token missing or invalid")
    }

    func test_errorBody_serverAlreadyRunning_has_no_detail() throws {
        let value = try roundTrip(IPCErrorBody.self, from: Fixtures.errorBodyServerAlreadyRunning)
        XCTAssertEqual(value.code, .serverAlreadyRunning)
        XCTAssertNil(value.detail)
    }

    func test_serverActionResponse_accepted() throws {
        let value = try roundTrip(IPCServerActionResponse.self, from: Fixtures.serverActionResponseAccepted)
        XCTAssertTrue(value.accepted)
        XCTAssertEqual(value.state, .starting)
    }

    func test_serverActionResponse_noop() throws {
        let value = try roundTrip(IPCServerActionResponse.self, from: Fixtures.serverActionResponseNoop)
        XCTAssertFalse(value.accepted)
        XCTAssertEqual(value.state, .running)
    }

    func test_openWebTargetResponse() throws {
        let value = try roundTrip(IPCOpenWebTargetResponse.self, from: Fixtures.openWebTargetResponse)
        XCTAssertEqual(value.url, "http://localhost:3001")
    }

    func test_crashFilesResponse_sortedByRecency() throws {
        let value = try roundTrip(IPCCrashFilesResponse.self, from: Fixtures.crashFilesResponse)
        XCTAssertEqual(value.files.count, 2)
        let sorted = value.sortedByRecency
        XCTAssertEqual(sorted.first?.mtimeMs, 1_732_400_000_000)
        XCTAssertEqual(sorted.last?.mtimeMs, 1_731_900_000_000)
    }

    func test_crashFilesResponse_empty() throws {
        let value = try roundTrip(IPCCrashFilesResponse.self, from: Fixtures.crashFilesResponseEmpty)
        XCTAssertEqual(value.files, [])
    }

    // MARK: - Closed-enum rejection (mirrors packages/controller-ipc/test/type-agreement.spec.ts's
    // "TS rejects out-of-enum literals" intent, adapted to what Swift's Codable actually
    // guarantees: an unrecognized rawValue string fails to decode, full stop.)

    func test_processState_rejects_unknown_member() {
        let json = Fixtures.processInfoRunning.replacingOccurrences(of: "\"running\"", with: "\"booting\"")
        let data = json.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(IPCProcessInfo.self, from: data))
    }

    func test_errorCode_rejects_unknown_member() {
        let json = Fixtures.errorBodyUnauthorized.replacingOccurrences(of: "\"unauthorized\"", with: "\"boom\"")
        let data = json.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(IPCErrorBody.self, from: data))
    }

    func test_provisioningState_rejects_unknown_member() {
        let json = Fixtures.provisioningStatusExternal.replacingOccurrences(of: "\"external\"", with: "\"phantom\"")
        let data = json.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(ProvisioningStatus.self, from: data))
    }
}
