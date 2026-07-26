// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/IpcModelSerializationTests.cs
//
// Fixture VALUES below are copied by hand from the FROZEN
// packages/controller-ipc TypeScript test suite — specifically:
//   - packages/controller-ipc/test/transport.spec.ts        (IpcDiscoveryFile)
//   - packages/controller-ipc/test/process-info.spec.ts     (ProcessInfo)
//   - packages/controller-ipc/test/status.spec.ts           (IpcStatusResponse)
//   - packages/controller-ipc/test/server-lifecycle.spec.ts (IpcServerActionResponse)
//   - packages/controller-ipc/test/open-web-target.spec.ts  (OpenWebTargetResponse)
//   - packages/controller-ipc/test/crash-files.spec.ts      (CrashFilesResponse)
//   - packages/controller-ipc/test/error-body.spec.ts       (IpcErrorBody, IPC_ERROR_CODES)
// as of this lane's dispatch (2026-07-24, commit 34979cb). KEPT IN SYNC
// MANUALLY — see IpcModels.cs's header. If a TS fixture value above
// changes, this file's copy must be hand-updated to match; there is no
// generator enforcing the two stay identical, only the fact that this
// suite will start asserting against a stale value if nobody does.
//
// What these tests prove: that Loombre.Tray.Ipc's System.Text.Json models
// round-trip the EXACT wire shapes the real TS-side server produces
// (property names, required-vs-nullable, and the string-union wire
// values), using real bytes lifted from the source of truth rather than
// C#-side-invented fixtures that could quietly diverge from the contract.

using System.Text.Json;
using Loombre.Tray.Ipc;
using Xunit;

namespace Loombre.Tray.Tests;

public class IpcModelSerializationTests
{
    // ---- transport.spec.ts: "accepts a well-formed discovery file" ----
    [Fact]
    public void Deserializes_IpcDiscoveryFile()
    {
        const string json = """
            {"port":54871,"host":"127.0.0.1","pid":4821,"startedAtMs":1800000000000}
            """;

        var file = JsonSerializer.Deserialize<IpcDiscoveryFile>(json);

        Assert.NotNull(file);
        Assert.Equal(54871, file!.Port);
        Assert.Equal("127.0.0.1", file.Host);
        Assert.Equal(4821, file.Pid);
        Assert.Equal(1_800_000_000_000L, file.StartedAtMs);
    }

    // ---- process-info.spec.ts: "accepts every closed state" (running case) ----
    [Fact]
    public void Deserializes_a_running_ProcessInfo()
    {
        const string json = """
            {"state":"running","pid":4821,"startedAtMs":1800000000000,"version":"0.1.0"}
            """;

        var info = JsonSerializer.Deserialize<ProcessInfo>(json);

        Assert.NotNull(info);
        Assert.Equal(ProcessStates.Running, info!.State);
        Assert.Equal(4821, info.Pid);
        Assert.Equal(1_800_000_000_000L, info.StartedAtMs);
        Assert.Equal("0.1.0", info.Version);
    }

    // ---- process-info.spec.ts: stopped state carries null pid/startedAtMs ----
    [Fact]
    public void Deserializes_a_stopped_ProcessInfo_with_null_pid_and_startedAtMs()
    {
        const string json = """
            {"state":"stopped","pid":null,"startedAtMs":null,"version":"0.1.0"}
            """;

        var info = JsonSerializer.Deserialize<ProcessInfo>(json);

        Assert.NotNull(info);
        Assert.Equal(ProcessStates.Stopped, info!.State);
        Assert.Null(info.Pid);
        Assert.Null(info.StartedAtMs);
    }

    // ---- status.spec.ts: "accepts a well-formed status response, embedding
    // a real ProvisioningStatus" ----
    [Fact]
    public void Deserializes_a_full_IpcStatusResponse()
    {
        const string json = """
            {
              "ipcContractVersion": 1,
              "server": {"state":"running","pid":4821,"startedAtMs":1800000000000,"version":"0.1.0"},
              "worker": {"state":"running","pid":4821,"startedAtMs":1800000000000,"version":"0.1.0"},
              "webUrl": "http://127.0.0.1:8080",
              "provisioning": {"state":"ready","pgVersion":"17.4","dataDir":"/var/lib/loombre/pgdata","lastCheckMs":1800000000000}
            }
            """;

        var status = JsonSerializer.Deserialize<IpcStatusResponse>(json);

        Assert.NotNull(status);
        Assert.Equal(1, status!.IpcContractVersion);
        Assert.Equal(ContractVersion.ControllerIpcContractVersion, status.IpcContractVersion);
        Assert.Equal(ProcessStates.Running, status.Server.State);
        Assert.Equal("http://127.0.0.1:8080", status.WebUrl);
        Assert.Equal(ProvisioningStates.Ready, status.Provisioning.State);
        Assert.Equal("17.4", status.Provisioning.PgVersion);
        Assert.Equal("/var/lib/loombre/pgdata", status.Provisioning.DataDir);
    }

    // ---- status.spec.ts: "accepts a null webUrl while the server is not
    // in a state that serves the web client" ----
    [Fact]
    public void Deserializes_IpcStatusResponse_with_null_webUrl_and_absent_provisioning()
    {
        const string json = """
            {
              "ipcContractVersion": 1,
              "server": {"state":"stopped","pid":null,"startedAtMs":null,"version":"0.1.0"},
              "worker": {"state":"stopped","pid":null,"startedAtMs":null,"version":"0.1.0"},
              "webUrl": null,
              "provisioning": {"state":"absent","pgVersion":null,"dataDir":null,"lastCheckMs":0}
            }
            """;

        var status = JsonSerializer.Deserialize<IpcStatusResponse>(json);

        Assert.NotNull(status);
        Assert.Null(status!.WebUrl);
        Assert.Equal(ProvisioningStates.Absent, status.Provisioning.State);
        Assert.Null(status.Provisioning.PgVersion);
        Assert.Null(status.Provisioning.DataDir);
    }

    // ---- server-lifecycle.spec.ts: server/start "accepts accepted+state" ----
    [Fact]
    public void Deserializes_IpcServerActionResponse_starting()
    {
        const string json = """{"accepted":true,"state":"starting"}""";

        var action = JsonSerializer.Deserialize<IpcServerActionResponse>(json);

        Assert.NotNull(action);
        Assert.True(action!.Accepted);
        Assert.Equal(ProcessStates.Starting, action.State);
    }

    // ---- server-lifecycle.spec.ts: "accepts accepted:false for a no-op
    // (already running)" ----
    [Fact]
    public void Deserializes_IpcServerActionResponse_noop_already_running()
    {
        const string json = """{"accepted":false,"state":"running"}""";

        var action = JsonSerializer.Deserialize<IpcServerActionResponse>(json);

        Assert.NotNull(action);
        Assert.False(action!.Accepted);
        Assert.Equal(ProcessStates.Running, action.State);
    }

    // ---- server-lifecycle.spec.ts: server/stop "accepts accepted+state" ----
    [Fact]
    public void Deserializes_IpcServerActionResponse_stopping()
    {
        const string json = """{"accepted":true,"state":"stopping"}""";

        var action = JsonSerializer.Deserialize<IpcServerActionResponse>(json);

        Assert.NotNull(action);
        Assert.Equal(ProcessStates.Stopping, action.State);
    }

    // ---- open-web-target.spec.ts: "accepts a well-formed url" ----
    [Fact]
    public void Deserializes_OpenWebTargetResponse()
    {
        const string json = """{"url":"http://127.0.0.1:8080"}""";

        var target = JsonSerializer.Deserialize<OpenWebTargetResponse>(json);

        Assert.NotNull(target);
        Assert.Equal("http://127.0.0.1:8080", target!.Url);
    }

    // ---- crash-files.spec.ts: "response schema accepts an empty list and a
    // populated list" ----
    [Fact]
    public void Deserializes_CrashFilesResponse_with_an_empty_list()
    {
        const string json = """{"files":[]}""";

        var response = JsonSerializer.Deserialize<CrashFilesResponse>(json);

        Assert.NotNull(response);
        Assert.Empty(response!.Files);
    }

    [Fact]
    public void Deserializes_CrashFilesResponse_with_a_populated_list()
    {
        const string json = """
            {
              "files": [
                {"path":"/var/lib/loombre/crashes/server-2026-07-24T00-00-00.log","mtimeMs":1800000000000},
                {"path":"/var/lib/loombre/crashes/worker-2026-07-23T00-00-00.log","mtimeMs":1799900000000}
              ]
            }
            """;

        var response = JsonSerializer.Deserialize<CrashFilesResponse>(json);

        Assert.NotNull(response);
        Assert.Equal(2, response!.Files.Count);
        Assert.Equal("/var/lib/loombre/crashes/server-2026-07-24T00-00-00.log", response.Files[0].Path);
        Assert.Equal(1_800_000_000_000L, response.Files[0].MtimeMs);
        Assert.Equal(1_799_900_000_000L, response.Files[1].MtimeMs);
    }

    // ---- error-body.spec.ts: "accepts every closed code with a
    // satisfies-typed fixture" — IPC_ERROR_CODES enumerated literally. ----
    [Theory]
    [InlineData("unauthorized")]
    [InlineData("server-already-running")]
    [InlineData("server-not-running")]
    [InlineData("web-url-unavailable")]
    [InlineData("internal-error")]
    public void Deserializes_IpcErrorBody_for_every_closed_code(string code)
    {
        var json = $$"""{"title":"Something went wrong","status":409,"code":"{{code}}"}""";

        var body = JsonSerializer.Deserialize<IpcErrorBody>(json);

        Assert.NotNull(body);
        Assert.Equal("Something went wrong", body!.Title);
        Assert.Equal(409, body.Status);
        Assert.Equal(code, body.Code);
    }

    [Fact]
    public void IpcErrorCodes_constants_match_the_closed_set_this_test_enumerates()
    {
        // Guards the Theory above against silently going stale if
        // IpcErrorCodes ever gains/loses a member without the InlineData
        // list above being updated to match (the TS side's own
        // IPC_ERROR_CODES runtime array is what actually enumerates the
        // set — this is the closest a hand-copied mirror can get to that
        // without a generator).
        Assert.Equal("unauthorized", IpcErrorCodes.Unauthorized);
        Assert.Equal("server-already-running", IpcErrorCodes.ServerAlreadyRunning);
        Assert.Equal("server-not-running", IpcErrorCodes.ServerNotRunning);
        Assert.Equal("web-url-unavailable", IpcErrorCodes.WebUrlUnavailable);
        Assert.Equal("internal-error", IpcErrorCodes.InternalError);
    }
}
