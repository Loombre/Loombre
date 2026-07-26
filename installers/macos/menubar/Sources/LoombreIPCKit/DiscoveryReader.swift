// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/DiscoveryReader.swift
//
// Reads the discovery+token file pair (transport.ts) from the app-data ipc
// directory and turns them into a connection the IPCClient can use.
// Deliberately takes the files' contents as parameters rather than reading
// disk itself in the primary initializer, so this stays a pure, easily
// testable transform — the thin `load()` convenience wraps real file I/O
// for production callers (AppDelegate.swift).

import Foundation

/// Injectable liveness check for the discovery file's `pid` — separated
/// from DiscoveryReader so tests can fake "is this pid alive" without
/// depending on real process state.
public protocol ProcessLivenessChecking {
    func isRunning(pid: Int32) -> Bool
}

/// Real implementation: `kill(pid, 0)` — the standard POSIX no-op signal
/// used purely to test process existence + permission, sends nothing.
public struct SystemProcessLivenessChecker: ProcessLivenessChecking {
    public init() {}
    public func isRunning(pid: Int32) -> Bool {
        // kill returns 0 if the signal could be delivered (process exists
        // and we have permission), -1 with errno otherwise. errno==ESRCH
        // means "no such process" — definitively stale. Any other errno
        // (e.g. EPERM, exists but owned by _loombre) still proves the pid
        // is alive, just not signalable by us — treat as running.
        if kill(pid, 0) == 0 { return true }
        return errno != ESRCH
    }
}

public enum DiscoveryError: Error, Equatable {
    case discoveryFileMissing
    case tokenFileMissing
    case staleProcess(pid: Int32)
}

public struct IPCConnection: Equatable {
    public let baseURL: URL
    public let token: String
    public let discovery: IPCDiscoveryFile

    public init(baseURL: URL, token: String, discovery: IPCDiscoveryFile) {
        self.baseURL = baseURL
        self.token = token
        self.discovery = discovery
    }
}

public enum DiscoveryReader {
    /// Pure core: given already-read discovery JSON bytes + token text,
    /// produce a connection or a typed reason it's unusable. `checker`
    /// defaults to the real one but is injectable for tests.
    public static func resolve(
        discoveryData: Data,
        tokenText: String,
        checker: ProcessLivenessChecking = SystemProcessLivenessChecker()
    ) throws -> IPCConnection {
        let discovery = try IPCDiscoveryFile.decode(discoveryData)

        guard checker.isRunning(pid: discovery.pid) else {
            throw DiscoveryError.staleProcess(pid: discovery.pid)
        }

        // Token file format per transport.ts: "raw UTF-8 text (no JSON
        // wrapper, no trailing newline required)" — trim exactly one
        // trailing newline if present (common when the writer used a
        // shell `echo`/heredoc), but never trim internal whitespace since
        // the token itself is opaque.
        var token = tokenText
        if token.hasSuffix("\n") { token.removeLast() }

        guard var components = URLComponents() as URLComponents? else {
            fatalError("URLComponents() must always succeed for an empty initializer")
        }
        components.scheme = "http"
        components.host = discovery.host
        components.port = discovery.port
        components.path = IPCTransport.basePath

        guard let url = components.url else {
            fatalError("constructing the IPC base URL from a validated discovery file must succeed")
        }

        return IPCConnection(baseURL: url, token: token, discovery: discovery)
    }

    /// Production convenience: reads both files from LoombreAppPaths and
    /// resolves them. Kept separate from `resolve` so unit tests never
    /// touch the real filesystem.
    public static func load(checker: ProcessLivenessChecking = SystemProcessLivenessChecker()) throws -> IPCConnection {
        let fm = FileManager.default
        guard let discoveryData = fm.contents(atPath: LoombreAppPaths.discoveryFileURL.path) else {
            throw DiscoveryError.discoveryFileMissing
        }
        guard let tokenData = fm.contents(atPath: LoombreAppPaths.tokenFileURL.path),
              let tokenText = String(data: tokenData, encoding: .utf8) else {
            throw DiscoveryError.tokenFileMissing
        }
        return try resolve(discoveryData: discoveryData, tokenText: tokenText, checker: checker)
    }
}
