// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/IpcModels.cs
//
// Hand-mirrors the FROZEN packages/controller-ipc/src/*.ts contract (never
// edited — a needed change there is a STOP-and-report per this lane's
// brief, not a workaround here). Types + wire constants only, matching
// that package's own "types + JSON-schema fixtures only, no I/O"
// description (packages/controller-ipc/package.json).
//
// KEPT IN SYNC MANUALLY. There is no code generator bridging TypeScript
// and C# in this repo (CLAUDE.md invariant 1's "the SDK is generated"
// applies to packages/contract's public REST API only, not this loopback-
// only IPC contract). Whoever edits packages/controller-ipc/src/*.ts must
// hand-edit this file to match — Loombre.Tray.Tests/IpcModelSerializationTests.cs
// pins literal fixture VALUES copied from packages/controller-ipc/test/*.spec.ts
// (see that test file's own header) so a drift shows up as a FAILING C#
// test against real contract fixtures, not a silent runtime mismatch the
// first time a real server responds.
//
// String-union wire values (ProcessState, ProvisioningState, IpcErrorCode):
// modeled as plain `string` fields + a sibling `public static class …s`
// holding named constants — NOT C# `enum` types. Several wire values
// contain hyphens ("server-already-running") that are not valid C# enum
// member identifiers, and a hand-picked PascalCase spelling would be one
// more thing to keep in sync with the wire text on every TS-side edit.
// A plain string constant IS the wire text, so there is nothing to keep in
// sync beyond the constant's own value — closer to the TS side's own
// "string literal union + PROCESS_STATES runtime array" pattern than an
// enum would be.

using System.Text.Json.Serialization;

namespace Loombre.Tray.Ipc;

/// <summary>packages/controller-ipc/src/contract-version.ts</summary>
public static class ContractVersion
{
    public const int ControllerIpcContractVersion = 1;
}

/// <summary>packages/controller-ipc/src/transport.ts</summary>
public static class Transport
{
    public const string BasePath = "/ipc/v1";
    public const string LoopbackHost = "127.0.0.1";
    public const string DiscoveryFilename = "controller-ipc.json";
    public const string TokenFilename = "controller-ipc.token";
    public const string AuthScheme = "Bearer";
}

/// <summary>packages/controller-ipc/src/transport.ts's IpcDiscoveryFile.</summary>
public sealed class IpcDiscoveryFile
{
    [JsonPropertyName("port")]
    public required int Port { get; init; }

    [JsonPropertyName("host")]
    public required string Host { get; init; }

    [JsonPropertyName("pid")]
    public required int Pid { get; init; }

    [JsonPropertyName("startedAtMs")]
    public required long StartedAtMs { get; init; }
}

/// <summary>packages/controller-ipc/src/process-info.ts's ProcessState
/// union (runtime PROCESS_STATES mirror — see this file's header for why
/// this is a string-constants class, not a C# enum).</summary>
public static class ProcessStates
{
    public const string Stopped = "stopped";
    public const string Starting = "starting";
    public const string Running = "running";
    public const string Stopping = "stopping";
    public const string Crashed = "crashed";
}

/// <summary>packages/controller-ipc/src/process-info.ts's ProcessInfo.</summary>
public sealed class ProcessInfo
{
    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("pid")]
    public int? Pid { get; init; }

    [JsonPropertyName("startedAtMs")]
    public long? StartedAtMs { get; init; }

    [JsonPropertyName("version")]
    public required string Version { get; init; }
}

/// <summary>@loombre/provisioning's ProvisioningState union — status.ts's
/// ONLY cross-package import (this file's header), reused verbatim rather
/// than re-declared with different spelling.</summary>
public static class ProvisioningStates
{
    public const string Absent = "absent";
    public const string Provisioning = "provisioning";
    public const string Ready = "ready";
    public const string Upgrading = "upgrading";
    public const string Corrupt = "corrupt";
    public const string External = "external";
}

/// <summary>@loombre/provisioning's ProvisioningStatus.</summary>
public sealed class ProvisioningStatus
{
    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("pgVersion")]
    public string? PgVersion { get; init; }

    [JsonPropertyName("dataDir")]
    public string? DataDir { get; init; }

    [JsonPropertyName("lastCheckMs")]
    public required long LastCheckMs { get; init; }

    [JsonPropertyName("detail")]
    public string? Detail { get; init; }
}

/// <summary>packages/controller-ipc/src/status.ts's IpcStatusResponse.
/// The TS type flattens VersionInfo onto this via `extends`; C# has no
/// structural interface-merge for a plain data shape, so IpcContractVersion
/// is declared directly on this class instead of a separate VersionInfo
/// type that would only get flattened right back.</summary>
public sealed class IpcStatusResponse
{
    [JsonPropertyName("ipcContractVersion")]
    public required int IpcContractVersion { get; init; }

    [JsonPropertyName("server")]
    public required ProcessInfo Server { get; init; }

    [JsonPropertyName("worker")]
    public required ProcessInfo Worker { get; init; }

    [JsonPropertyName("webUrl")]
    public string? WebUrl { get; init; }

    [JsonPropertyName("provisioning")]
    public required ProvisioningStatus Provisioning { get; init; }
}

/// <summary>packages/controller-ipc/src/server-lifecycle.ts's
/// IpcServerActionResponse — shared by /server/start and /server/stop.</summary>
public sealed class IpcServerActionResponse
{
    [JsonPropertyName("accepted")]
    public required bool Accepted { get; init; }

    [JsonPropertyName("state")]
    public required string State { get; init; }
}

/// <summary>packages/controller-ipc/src/open-web-target.ts's
/// OpenWebTargetResponse.</summary>
public sealed class OpenWebTargetResponse
{
    [JsonPropertyName("url")]
    public required string Url { get; init; }
}

/// <summary>packages/controller-ipc/src/crash-files.ts's CrashFileEntry.</summary>
public sealed class CrashFileEntry
{
    [JsonPropertyName("path")]
    public required string Path { get; init; }

    [JsonPropertyName("mtimeMs")]
    public required long MtimeMs { get; init; }
}

/// <summary>packages/controller-ipc/src/crash-files.ts's CrashFilesResponse.</summary>
public sealed class CrashFilesResponse
{
    [JsonPropertyName("files")]
    public required List<CrashFileEntry> Files { get; init; }
}

/// <summary>packages/controller-ipc/src/error-body.ts's IpcErrorCode union
/// (see this file's header for why this is a string-constants class).</summary>
public static class IpcErrorCodes
{
    public const string Unauthorized = "unauthorized";
    public const string ServerAlreadyRunning = "server-already-running";
    public const string ServerNotRunning = "server-not-running";
    public const string WebUrlUnavailable = "web-url-unavailable";
    public const string InternalError = "internal-error";
}

/// <summary>packages/controller-ipc/src/error-body.ts's IpcErrorBody — the
/// shape of every non-2xx response body this contract's server side
/// returns.</summary>
public sealed class IpcErrorBody
{
    [JsonPropertyName("title")]
    public required string Title { get; init; }

    [JsonPropertyName("status")]
    public required int Status { get; init; }

    [JsonPropertyName("code")]
    public required string Code { get; init; }

    [JsonPropertyName("detail")]
    public string? Detail { get; init; }
}
