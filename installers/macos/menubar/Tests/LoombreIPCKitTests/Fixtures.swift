// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: Tests/LoombreIPCKitTests/Fixtures.swift
//
// COPIED from installers/macos/menubar/fixtures.json — kept as Swift
// string literals (rather than an SPM bundle resource) so these tests have
// zero resource-bundling surface to get wrong. fixtures.json is itself
// validated against @loombre/controller-ipc + @loombre/provisioning's REAL
// Ajv schemas by installers/macos/menubar/verify-fixtures.mjs.
//
// SYNC NOTE: if you edit fixtures.json, copy the changed literal(s) here
// too, then re-run `node installers/macos/menubar/verify-fixtures.mjs`.
// There is no automated cross-language sync — this comment plus the
// verify script are the discipline.

enum Fixtures {
    static let discoveryFile = """
    {
      "port": 54217,
      "host": "127.0.0.1",
      "pid": 4242,
      "startedAtMs": 1732400000000
    }
    """

    static let processInfoRunning = """
    {
      "state": "running",
      "pid": 4242,
      "startedAtMs": 1732400000000,
      "version": "0.0.1"
    }
    """

    static let processInfoStopped = """
    {
      "state": "stopped",
      "pid": null,
      "startedAtMs": null,
      "version": "0.0.1"
    }
    """

    static let processInfoCrashed = """
    {
      "state": "crashed",
      "pid": null,
      "startedAtMs": 1732400000000,
      "version": "0.0.1"
    }
    """

    static let provisioningStatusExternal = """
    {
      "state": "external",
      "pgVersion": null,
      "dataDir": null,
      "lastCheckMs": 1732400000000
    }
    """

    static let provisioningStatusReady = """
    {
      "state": "ready",
      "pgVersion": "17.4",
      "dataDir": "/Library/Application Support/Loombre/db",
      "lastCheckMs": 1732400000000,
      "detail": "ok"
    }
    """

    static let statusResponseHealthy = """
    {
      "ipcContractVersion": 1,
      "server": {
        "state": "running",
        "pid": 4242,
        "startedAtMs": 1732400000000,
        "version": "0.0.1"
      },
      "worker": {
        "state": "running",
        "pid": 4243,
        "startedAtMs": 1732400000000,
        "version": "0.0.1"
      },
      "webUrl": "http://localhost:3001",
      "provisioning": {
        "state": "external",
        "pgVersion": null,
        "dataDir": null,
        "lastCheckMs": 1732400000000
      }
    }
    """

    static let statusResponseStopped = """
    {
      "ipcContractVersion": 1,
      "server": {
        "state": "stopped",
        "pid": null,
        "startedAtMs": null,
        "version": "0.0.1"
      },
      "worker": {
        "state": "stopped",
        "pid": null,
        "startedAtMs": null,
        "version": "0.0.1"
      },
      "webUrl": null,
      "provisioning": {
        "state": "external",
        "pgVersion": null,
        "dataDir": null,
        "lastCheckMs": 1732400000000
      }
    }
    """

    static let statusResponseCrashed = """
    {
      "ipcContractVersion": 1,
      "server": {
        "state": "crashed",
        "pid": null,
        "startedAtMs": 1732400000000,
        "version": "0.0.1"
      },
      "worker": {
        "state": "running",
        "pid": 4243,
        "startedAtMs": 1732400000000,
        "version": "0.0.1"
      },
      "webUrl": null,
      "provisioning": {
        "state": "corrupt",
        "pgVersion": "17.4",
        "dataDir": "/Library/Application Support/Loombre/db",
        "lastCheckMs": 1732400000000,
        "detail": "checksum-failure"
      }
    }
    """

    /// A server one contract version AHEAD of this client build — NOT in
    /// fixtures.json (that file mirrors real schema-valid wire values only;
    /// this is a client-side-only test scenario for the mismatch-notice
    /// logic, so it stays local to the Swift test target).
    static let statusResponseContractMismatch = """
    {
      "ipcContractVersion": 2,
      "server": {
        "state": "running",
        "pid": 4242,
        "startedAtMs": 1732400000000,
        "version": "0.2.0"
      },
      "worker": {
        "state": "running",
        "pid": 4243,
        "startedAtMs": 1732400000000,
        "version": "0.2.0"
      },
      "webUrl": "http://localhost:3001",
      "provisioning": {
        "state": "external",
        "pgVersion": null,
        "dataDir": null,
        "lastCheckMs": 1732400000000
      }
    }
    """

    static let errorBodyUnauthorized = """
    {
      "title": "Unauthorized",
      "status": 401,
      "code": "unauthorized",
      "detail": "Bearer token missing or invalid"
    }
    """

    static let errorBodyServerAlreadyRunning = """
    {
      "title": "Server already running",
      "status": 409,
      "code": "server-already-running"
    }
    """

    static let serverActionResponseAccepted = """
    {
      "accepted": true,
      "state": "starting"
    }
    """

    static let serverActionResponseNoop = """
    {
      "accepted": false,
      "state": "running"
    }
    """

    static let openWebTargetResponse = """
    {
      "url": "http://localhost:3001"
    }
    """

    static let crashFilesResponse = """
    {
      "files": [
        {
          "path": "/Library/Application Support/Loombre/crash/2026-07-24T00-00-00.log",
          "mtimeMs": 1732400000000
        },
        {
          "path": "/Library/Application Support/Loombre/crash/2026-07-20T11-30-00.log",
          "mtimeMs": 1731900000000
        }
      ]
    }
    """

    static let crashFilesResponseEmpty = """
    {
      "files": []
    }
    """
}
