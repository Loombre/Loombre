// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/IpcClientTests.cs
//
// Exercises IpcClient's request-shaping (base path, method, bearer auth
// header) and error-body mapping against a fake HttpMessageHandler — no
// real socket, no real server, per Loombre.Tray.Ipc's own design (see that
// project's header). Response-body fixture values here reuse the same
// literals as IpcModelSerializationTests.cs (sourced from
// packages/controller-ipc/test/*.spec.ts — see that file's header) so a
// round-trip through the ACTUAL public methods (GetStatusAsync,
// StartServerAsync, …) is proven too, not just raw
// JsonSerializer.Deserialize calls.

using System.Net;
using Loombre.Tray.Ipc;
using Xunit;

namespace Loombre.Tray.Tests;

public class IpcClientTests
{
    private static readonly Uri BaseAddress = new("http://127.0.0.1:54871");

    [Fact]
    public async Task GetStatusAsync_sends_the_contract_base_path_and_bearer_token()
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
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.OK, json);
        using var client = new IpcClient(BaseAddress, "secret-token-123", handler);

        var status = await client.GetStatusAsync();

        Assert.Equal(HttpMethod.Get, handler.LastRequest!.Method);
        Assert.Equal("/ipc/v1/status", handler.LastRequest.RequestUri!.AbsolutePath);
        Assert.Equal(Transport.AuthScheme, handler.LastRequest.Headers.Authorization!.Scheme);
        Assert.Equal("secret-token-123", handler.LastRequest.Headers.Authorization.Parameter);
        Assert.Equal(ProcessStates.Running, status.Server.State);
        Assert.Equal("http://127.0.0.1:8080", status.WebUrl);
    }

    [Fact]
    public async Task StartServerAsync_POSTs_to_server_start()
    {
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.OK, """{"accepted":true,"state":"starting"}""");
        using var client = new IpcClient(BaseAddress, "t", handler);

        var result = await client.StartServerAsync();

        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/ipc/v1/server/start", handler.LastRequest.RequestUri!.AbsolutePath);
        Assert.True(result.Accepted);
        Assert.Equal(ProcessStates.Starting, result.State);
    }

    [Fact]
    public async Task StopServerAsync_POSTs_to_server_stop()
    {
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.OK, """{"accepted":true,"state":"stopping"}""");
        using var client = new IpcClient(BaseAddress, "t", handler);

        var result = await client.StopServerAsync();

        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/ipc/v1/server/stop", handler.LastRequest.RequestUri!.AbsolutePath);
        Assert.Equal(ProcessStates.Stopping, result.State);
    }

    [Fact]
    public async Task GetOpenWebTargetAsync_GETs_open_web_target()
    {
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.OK, """{"url":"http://127.0.0.1:8080"}""");
        using var client = new IpcClient(BaseAddress, "t", handler);

        var result = await client.GetOpenWebTargetAsync();

        Assert.Equal("/ipc/v1/open-web-target", handler.LastRequest!.RequestUri!.AbsolutePath);
        Assert.Equal("http://127.0.0.1:8080", result.Url);
    }

    [Fact]
    public async Task GetCrashFilesAsync_GETs_crash_files()
    {
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.OK, """{"files":[]}""");
        using var client = new IpcClient(BaseAddress, "t", handler);

        var result = await client.GetCrashFilesAsync();

        Assert.Equal("/ipc/v1/crash-files", handler.LastRequest!.RequestUri!.AbsolutePath);
        Assert.Empty(result.Files);
    }

    // ---- error-body.spec.ts fixture shape, routed through a non-2xx
    // response: an unsuccessful status maps to a thrown IpcException
    // carrying the parsed IpcErrorBody, never a silent default/null. ----
    [Fact]
    public async Task A_non_2xx_response_throws_IpcException_with_the_parsed_body()
    {
        const string json = """{"title":"Server already running","status":409,"code":"server-already-running","detail":"LoombreServer is already in state running."}""";
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.Conflict, json);
        using var client = new IpcClient(BaseAddress, "t", handler);

        var ex = await Assert.ThrowsAsync<IpcException>(() => client.StartServerAsync());

        Assert.Equal(409, ex.StatusCode);
        Assert.NotNull(ex.Body);
        Assert.Equal(IpcErrorCodes.ServerAlreadyRunning, ex.Body!.Code);
        Assert.Equal("LoombreServer is already in state running.", ex.Message);
    }

    [Fact]
    public async Task A_non_2xx_response_with_a_non_JSON_body_still_throws_IpcException()
    {
        var handler = new FakeJsonHttpMessageHandler(HttpStatusCode.BadGateway, "<html>not json</html>");
        using var client = new IpcClient(BaseAddress, "t", handler);

        var ex = await Assert.ThrowsAsync<IpcException>(() => client.GetStatusAsync());

        Assert.Equal(502, ex.StatusCode);
        Assert.Null(ex.Body);
    }
}
