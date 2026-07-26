// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKit/ErrorBody.swift
//
// Mirrors packages/controller-ipc/src/error-body.ts verbatim.

import Foundation

public enum IPCErrorCode: String, Codable, CaseIterable, Equatable {
    case unauthorized
    case serverAlreadyRunning = "server-already-running"
    case serverNotRunning = "server-not-running"
    case webUrlUnavailable = "web-url-unavailable"
    case internalError = "internal-error"
}

public struct IPCErrorBody: Codable, Equatable {
    public let title: String
    public let status: Int
    public let code: IPCErrorCode
    public let detail: String?

    public init(title: String, status: Int, code: IPCErrorCode, detail: String? = nil) {
        self.title = title
        self.status = status
        self.code = code
        self.detail = detail
    }
}
