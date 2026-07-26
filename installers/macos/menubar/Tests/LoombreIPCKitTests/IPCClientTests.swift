// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/IPCClientTests.swift
//
// Tests IPCClient's request construction (path, method, Bearer header) and
// response parsing against Fixtures.swift's values, via a fake
// IPCHTTPTransport — no real network, no live @loombre/controller-ipc
// server (none exists in this tree yet, see installers/macos/LAYOUT.md §4).

import XCTest
@testable import LoombreIPCKit

private final class FakeTransport: IPCHTTPTransport {
    struct Canned {
        let statusCode: Int
        let body: String
    }

    var canned: Canned = Canned(statusCode: 200, body: "{}")
    private(set) var lastRequest: URLRequest?

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: canned.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (canned.body.data(using: .utf8)!, response)
    }
}

final class IPCClientTests: XCTestCase {
    private func makeConnection() -> IPCConnection {
        IPCConnection(
            baseURL: URL(string: "http://127.0.0.1:54217/ipc/v1")!,
            token: "sekrit-token",
            discovery: IPCDiscoveryFile(port: 54217, host: "127.0.0.1", pid: 4242, startedAtMs: 1_732_400_000_000)
        )
    }

    func test_fetchStatus_sends_correct_request_and_parses_response() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: Fixtures.statusResponseHealthy)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        let status = try await client.fetchStatus()

        XCTAssertEqual(status.server.state, .running)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "GET")
        XCTAssertEqual(transport.lastRequest?.url?.absoluteString, "http://127.0.0.1:54217/ipc/v1/status")
        XCTAssertEqual(
            transport.lastRequest?.value(forHTTPHeaderField: IPCTransport.authHeader),
            "Bearer sekrit-token"
        )
    }

    func test_startServer_is_a_POST_and_parses_accepted_response() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: Fixtures.serverActionResponseAccepted)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        let result = try await client.startServer()

        XCTAssertTrue(result.accepted)
        XCTAssertEqual(result.state, .starting)
        XCTAssertEqual(transport.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(transport.lastRequest?.url?.absoluteString, "http://127.0.0.1:54217/ipc/v1/server/start")
    }

    func test_stopServer_noop_response() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: Fixtures.serverActionResponseNoop)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        let result = try await client.stopServer()

        XCTAssertFalse(result.accepted)
        XCTAssertEqual(transport.lastRequest?.url?.absoluteString, "http://127.0.0.1:54217/ipc/v1/server/stop")
    }

    func test_openWebTarget_parses_url() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: Fixtures.openWebTargetResponse)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        let result = try await client.openWebTarget()

        XCTAssertEqual(result.url, "http://localhost:3001")
    }

    func test_crashFiles_parses_list() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: Fixtures.crashFilesResponse)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        let result = try await client.crashFiles()

        XCTAssertEqual(result.files.count, 2)
    }

    func test_401_response_throws_apiError_with_parsed_body() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 401, body: Fixtures.errorBodyUnauthorized)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        do {
            _ = try await client.fetchStatus()
            XCTFail("expected apiError to be thrown")
        } catch IPCClientError.apiError(let body) {
            XCTAssertEqual(body.code, .unauthorized)
            XCTAssertEqual(body.status, 401)
        }
    }

    func test_409_server_already_running_on_start() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 409, body: Fixtures.errorBodyServerAlreadyRunning)
        let client = IPCClient(connection: makeConnection(), transport: transport)

        do {
            _ = try await client.startServer()
            XCTFail("expected apiError to be thrown")
        } catch IPCClientError.apiError(let body) {
            XCTAssertEqual(body.code, .serverAlreadyRunning)
        }
    }

    func test_malformed_error_body_falls_back_to_unexpectedStatus() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 500, body: "<html>not json</html>")
        let client = IPCClient(connection: makeConnection(), transport: transport)

        do {
            _ = try await client.fetchStatus()
            XCTFail("expected unexpectedStatus to be thrown")
        } catch IPCClientError.unexpectedStatus(let code) {
            XCTAssertEqual(code, 500)
        }
    }

    func test_malformed_success_body_throws_decoding_error() async throws {
        let transport = FakeTransport()
        transport.canned = .init(statusCode: 200, body: "{ \"nonsense\": true }")
        let client = IPCClient(connection: makeConnection(), transport: transport)

        do {
            _ = try await client.fetchStatus()
            XCTFail("expected decoding error to be thrown")
        } catch IPCClientError.decoding {
            // expected
        }
    }
}
