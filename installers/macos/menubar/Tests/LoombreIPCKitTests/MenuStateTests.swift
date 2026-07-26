// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/MenuStateTests.swift
//
// Pure logic tests for MenuState.derive(from:) against Fixtures.swift's
// status-response values — proves the icon-state mapping deterministically
// without AppKit or a running app.

import XCTest
@testable import LoombreIPCKit

final class MenuStateTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func status(_ json: String) throws -> IPCStatusResponse {
        try decoder.decode(IPCStatusResponse.self, from: json.data(using: .utf8)!)
    }

    func test_healthy_status_derives_running() throws {
        let state = MenuState.derive(from: try status(Fixtures.statusResponseHealthy))
        XCTAssertEqual(state, .running)
    }

    func test_stopped_status_derives_notRunning() throws {
        let state = MenuState.derive(from: try status(Fixtures.statusResponseStopped))
        XCTAssertEqual(state, .notRunning)
    }

    func test_crashed_server_derives_crashed_even_though_worker_is_running() throws {
        let state = MenuState.derive(from: try status(Fixtures.statusResponseCrashed))
        XCTAssertEqual(state, .crashed)
    }

    func test_contract_mismatch_takes_priority_over_everything_else() throws {
        let state = MenuState.derive(from: try status(Fixtures.statusResponseContractMismatch))
        XCTAssertEqual(state, .contractMismatch(serverVersion: 2, clientVersion: controllerIpcContractVersion))
    }

    /// Built directly (not string-patched off a fixture) — a running
    /// server with a non-running worker is a scenario fixtures.json
    /// doesn't carry (it mirrors real schema-valid VALUES, not every
    /// client-side derivation scenario), same rationale as
    /// statusResponseContractMismatch in Fixtures.swift.
    func test_running_server_with_stopped_worker_is_degraded_not_running() throws {
        let response = IPCStatusResponse(
            ipcContractVersion: 1,
            server: IPCProcessInfo(state: .running, pid: 1, startedAtMs: 1, version: "0.0.1"),
            worker: IPCProcessInfo(state: .stopped, pid: nil, startedAtMs: nil, version: "0.0.1"),
            webUrl: "http://localhost:3001",
            provisioning: ProvisioningStatus(state: .external, pgVersion: nil, dataDir: nil, lastCheckMs: 1)
        )
        let state = MenuState.derive(from: response)
        guard case .degraded(let detail) = state else {
            return XCTFail("expected .degraded, got \(state)")
        }
        XCTAssertTrue(detail.contains("stopped"))
    }

    func test_corrupt_provisioning_is_degraded_regardless_of_process_states() throws {
        // A healthy server + worker but corrupt provisioning — proves the
        // corrupt check is independent of process state, not just reachable
        // via a simultaneously-crashed server (which would otherwise win).
        let response = IPCStatusResponse(
            ipcContractVersion: 1,
            server: IPCProcessInfo(state: .running, pid: 1, startedAtMs: 1, version: "0.0.1"),
            worker: IPCProcessInfo(state: .running, pid: 2, startedAtMs: 1, version: "0.0.1"),
            webUrl: "http://localhost:3001",
            provisioning: ProvisioningStatus(state: .corrupt, pgVersion: "17.4", dataDir: "/x", lastCheckMs: 1, detail: "disk-full")
        )
        let state = MenuState.derive(from: response)
        guard case .degraded(let detail) = state else {
            return XCTFail("expected .degraded, got \(state)")
        }
        XCTAssertTrue(detail.contains("disk-full"))
    }

    func test_unreachable_derives_notRunning() {
        XCTAssertEqual(MenuState.deriveFromUnreachable(), .notRunning)
    }

    func test_every_state_has_a_non_empty_symbol_and_label() {
        let allStates: [MenuIconState] = [
            .notRunning, .starting, .running, .stopping, .crashed,
            .degraded(detail: "x"), .contractMismatch(serverVersion: 2, clientVersion: 1),
        ]
        for state in allStates {
            XCTAssertFalse(MenuState.symbolName(for: state).isEmpty)
            XCTAssertFalse(MenuState.statusLabel(for: state).isEmpty)
        }
    }

    func test_isActionable() {
        XCTAssertTrue(MenuIconState.notRunning.isActionable)
        XCTAssertTrue(MenuIconState.running.isActionable)
        XCTAssertTrue(MenuIconState.crashed.isActionable)
        XCTAssertTrue(MenuIconState.degraded(detail: "x").isActionable)
        XCTAssertFalse(MenuIconState.starting.isActionable)
        XCTAssertFalse(MenuIconState.stopping.isActionable)
        XCTAssertFalse(MenuIconState.contractMismatch(serverVersion: 1, clientVersion: 1).isActionable)
    }
}
