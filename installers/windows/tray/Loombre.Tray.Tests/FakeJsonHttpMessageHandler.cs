// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/FakeJsonHttpMessageHandler.cs
//
// Minimal HttpMessageHandler test double: IpcClient is constructed with
// this instead of a real socket (IpcClient's `handler` constructor
// parameter exists exactly for this). Records the last request it saw so
// tests can assert on the method/path/Authorization header IpcClient sent.

using System.Net;
using System.Text;

namespace Loombre.Tray.Tests;

internal sealed class FakeJsonHttpMessageHandler : HttpMessageHandler
{
    private readonly HttpStatusCode _statusCode;
    private readonly string _jsonBody;

    public HttpRequestMessage? LastRequest { get; private set; }

    public FakeJsonHttpMessageHandler(HttpStatusCode statusCode, string jsonBody)
    {
        _statusCode = statusCode;
        _jsonBody = jsonBody;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        LastRequest = request;
        var response = new HttpResponseMessage(_statusCode)
        {
            Content = new StringContent(_jsonBody, Encoding.UTF8, "application/json"),
        };
        return Task.FromResult(response);
    }
}
