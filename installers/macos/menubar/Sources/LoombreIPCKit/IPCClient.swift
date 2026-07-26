// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/IPCClient.swift
//
// HTTP client for @loombre/controller-ipc's v1 transport. Network access is
// behind the `IPCHTTPTransport` protocol (not called directly on
// URLSession) specifically so XCTest can inject a fake transport carrying
// this lane's fixture JSON (fixtures.json / Fixtures.swift) and prove
// request-shape + response-parsing correctness without a live server or
// real sockets — there is no @loombre/controller-ipc HTTP SERVER
// implementation anywhere in this tree yet to test against live (see
// installers/macos/LAYOUT.md §4), so fixture-based testing is not a
// shortcut here, it's the only thing available to test against.

import Foundation

public protocol IPCHTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Real implementation: URLSession.shared (or an injected session).
public struct URLSessionIPCTransport: IPCHTTPTransport {
    private let session: URLSession
    public init(session: URLSession = .shared) {
        self.session = session
    }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw IPCClientError.transport(URLError(.badServerResponse))
        }
        return (data, http)
    }
}

public enum IPCClientError: Error, Equatable {
    case transport(Error)
    case decoding(Error)
    /// Non-2xx response whose body parsed as IPCErrorBody.
    case apiError(IPCErrorBody)
    /// Non-2xx response whose body did NOT parse as IPCErrorBody (a
    /// malformed/foreign server) — status code preserved for display.
    case unexpectedStatus(Int)

    public static func == (lhs: IPCClientError, rhs: IPCClientError) -> Bool {
        switch (lhs, rhs) {
        case let (.apiError(a), .apiError(b)): return a == b
        case let (.unexpectedStatus(a), .unexpectedStatus(b)): return a == b
        case (.transport, .transport): return true
        case (.decoding, .decoding): return true
        default: return false
        }
    }
}

/// Client side of @loombre/controller-ipc. One method per operation in the
/// frozen contract (status.ts, server-lifecycle.ts, open-web-target.ts,
/// crash-files.ts) — deliberately no generic "call(path:)" helper exposed
/// publicly, so each contract operation stays independently discoverable
/// and independently typed at the call site.
public final class IPCClient {
    private let connection: IPCConnection
    private let transport: IPCHTTPTransport
    private let decoder = JSONDecoder()

    public init(connection: IPCConnection, transport: IPCHTTPTransport = URLSessionIPCTransport()) {
        self.connection = connection
        self.transport = transport
    }

    private func request(path: String, method: String) -> URLRequest {
        var req = URLRequest(url: connection.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue(
            "\(IPCTransport.authScheme) \(connection.token)",
            forHTTPHeaderField: IPCTransport.authHeader
        )
        return req
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await transport.send(request)
        } catch let err as IPCClientError {
            throw err
        } catch {
            throw IPCClientError.transport(error)
        }

        guard (200..<300).contains(http.statusCode) else {
            if let body = try? decoder.decode(IPCErrorBody.self, from: data) {
                throw IPCClientError.apiError(body)
            }
            throw IPCClientError.unexpectedStatus(http.statusCode)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw IPCClientError.decoding(error)
        }
    }

    /// GET /ipc/v1/status
    public func fetchStatus() async throws -> IPCStatusResponse {
        try await perform(request(path: "status", method: "GET"), as: IPCStatusResponse.self)
    }

    /// POST /ipc/v1/server/start
    public func startServer() async throws -> IPCServerActionResponse {
        try await perform(request(path: "server/start", method: "POST"), as: IPCServerActionResponse.self)
    }

    /// POST /ipc/v1/server/stop
    public func stopServer() async throws -> IPCServerActionResponse {
        try await perform(request(path: "server/stop", method: "POST"), as: IPCServerActionResponse.self)
    }

    /// GET /ipc/v1/open-web-target
    public func openWebTarget() async throws -> IPCOpenWebTargetResponse {
        try await perform(request(path: "open-web-target", method: "GET"), as: IPCOpenWebTargetResponse.self)
    }

    /// GET /ipc/v1/crash-files
    public func crashFiles() async throws -> IPCCrashFilesResponse {
        try await perform(request(path: "crash-files", method: "GET"), as: IPCCrashFilesResponse.self)
    }
}
