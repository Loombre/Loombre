// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/Transport.swift
//
// Mirrors packages/controller-ipc/src/transport.ts verbatim (frozen
// 2026-07-24 — see that file's own header for the full loopback-only /
// discovery-file transport rationale; this is the CLIENT side of the same
// contract, so every constant below must match its TS counterpart exactly.
// SYNC NOTE: hand-mirrored, no codegen — see ContractVersion.swift.

import Foundation

public enum IPCTransport {
    /// Mount path for every operation in this contract.
    public static let basePath = "/ipc/v1"

    /// Loopback host the v1 HTTP transport binds to. Never 0.0.0.0 / ::.
    public static let loopbackHost = "127.0.0.1"

    /// Filename (under the platform app-data dir) holding the ephemeral
    /// port + discovery metadata as JSON. World-readable by design — a
    /// port number is not a secret.
    public static let discoveryFilename = "controller-ipc.json"

    /// Filename alongside discoveryFilename holding the bearer token as
    /// raw UTF-8 text (no JSON wrapper, no trailing newline required).
    /// MUST be 0600 on the writer's side — see
    /// installers/macos/LAYOUT.md §4 for the known multi-user gap this
    /// creates for a system-daemon posture, which this client does not
    /// attempt to paper over.
    public static let tokenFilename = "controller-ipc.token"

    public static let authHeader = "Authorization"
    public static let authScheme = "Bearer"
}

/// Mirrors IpcDiscoveryFile (transport.ts) + IPC_DISCOVERY_FILE_SCHEMA's
/// shape exactly: additionalProperties:false + all four fields required,
/// host locked to the literal "127.0.0.1".
public struct IPCDiscoveryFile: Codable, Equatable {
    public let port: Int
    public let host: String
    public let pid: Int32
    public let startedAtMs: Int64

    public init(port: Int, host: String, pid: Int32, startedAtMs: Int64) {
        self.port = port
        self.host = host
        self.pid = pid
        self.startedAtMs = startedAtMs
    }
}

public enum IPCDiscoveryFileError: Error, Equatable {
    /// host was present but not the literal "127.0.0.1" (IPC_DISCOVERY_FILE_SCHEMA's `const`).
    case unexpectedHost(String)
}

extension IPCDiscoveryFile {
    /// Ajv's `const: "127.0.0.1"` isn't expressible as a Swift enum case
    /// the way TS's string-literal type is without extra ceremony, so this
    /// decodes `host` as a plain String then validates it explicitly here
    /// — the closest practical mirror of the schema's actual constraint.
    public static func decode(_ data: Data) throws -> IPCDiscoveryFile {
        let file = try JSONDecoder().decode(IPCDiscoveryFile.self, from: data)
        guard file.host == IPCTransport.loopbackHost else {
            throw IPCDiscoveryFileError.unexpectedHost(file.host)
        }
        return file
    }
}
