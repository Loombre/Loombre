// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/IpcClient.cs
//
// Thin HTTP client for the FROZEN packages/controller-ipc contract
// (loopback-only, see transport.ts). Discovery (reading the port + token
// from the two well-known app-data files) is a SEPARATE class
// (Discovery.cs) — this class only knows how to talk to an already-
// resolved base address + bearer token, which is what makes it unit-
// testable without touching the filesystem or a real socket (tests inject
// an HttpMessageHandler — see Loombre.Tray.Tests/IpcClientTests.cs).

using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Loombre.Tray.Ipc;

public sealed class IpcException : Exception
{
    public IpcErrorBody? Body { get; }
    public int StatusCode { get; }

    public IpcException(int statusCode, IpcErrorBody? body)
        : base(body?.Detail ?? body?.Title ?? $"Loombre IPC request failed with status {statusCode}.")
    {
        StatusCode = statusCode;
        Body = body;
    }
}

public sealed class IpcClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new();

    private readonly HttpClient _http;

    /// <param name="baseAddress">e.g. http://127.0.0.1:&lt;discovered port&gt;
    /// — see Discovery.ReadAsync.</param>
    /// <param name="bearerToken">Raw token text read from
    /// Transport.TokenFilename — never logged (Discovery.cs).</param>
    /// <param name="handler">Test seam: inject a fake HttpMessageHandler
    /// instead of hitting a real socket. The client owns (disposes) the
    /// HttpClient it builds around this handler either way.</param>
    public IpcClient(Uri baseAddress, string bearerToken, HttpMessageHandler? handler = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = baseAddress;
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue(Transport.AuthScheme, bearerToken);
    }

    public Task<IpcStatusResponse> GetStatusAsync(CancellationToken ct = default) =>
        SendAsync<IpcStatusResponse>(HttpMethod.Get, "status", ct);

    public Task<IpcServerActionResponse> StartServerAsync(CancellationToken ct = default) =>
        SendAsync<IpcServerActionResponse>(HttpMethod.Post, "server/start", ct);

    public Task<IpcServerActionResponse> StopServerAsync(CancellationToken ct = default) =>
        SendAsync<IpcServerActionResponse>(HttpMethod.Post, "server/stop", ct);

    public Task<OpenWebTargetResponse> GetOpenWebTargetAsync(CancellationToken ct = default) =>
        SendAsync<OpenWebTargetResponse>(HttpMethod.Get, "open-web-target", ct);

    public Task<CrashFilesResponse> GetCrashFilesAsync(CancellationToken ct = default) =>
        SendAsync<CrashFilesResponse>(HttpMethod.Get, "crash-files", ct);

    private async Task<T> SendAsync<T>(HttpMethod method, string relativePath, CancellationToken ct)
    {
        // Transport.BasePath ("/ipc/v1") is the contract's mount path;
        // callers only ever supply the operation-relative suffix so it can
        // never be typo'd independently per call-site above.
        using var request = new HttpRequestMessage(method, $"{Transport.BasePath}/{relativePath}");
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            IpcErrorBody? body = null;
            try
            {
                body = await response.Content.ReadFromJsonAsync<IpcErrorBody>(JsonOptions, ct).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                // Non-JSON error body (e.g. something in front of the
                // loopback port returning a raw 502) — surfaced with
                // body: null, never crashes the caller trying to read it.
            }
            throw new IpcException((int)response.StatusCode, body);
        }

        var result = await response.Content.ReadFromJsonAsync<T>(JsonOptions, ct).ConfigureAwait(false);
        return result ?? throw new IpcException((int)response.StatusCode, null);
    }

    public void Dispose() => _http.Dispose();
}
