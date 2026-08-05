// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Tests/DiscoveryTests.cs
//
// Pins the two exception types FW1-D's tray-crash fix depends on.
// TrayApplicationContext's poll loop treats a torn discovery-file read as
// "server not ready yet, retry next poll" by catching
//   catch (Exception ex) when (ex is IOException or
//       UnauthorizedAccessException or JsonException or
//       InvalidOperationException)
// (see that file's ReadAsync call sites). That guard only works because
// Discovery.ReadAsync throws EXACTLY JsonException (from
// JsonSerializer.DeserializeAsync on malformed JSON) and EXACTLY
// InvalidOperationException (its own null/empty-file/empty-token checks)
// — never a wrapping/custom exception. Nothing else in this suite pins
// that, so a future refactor that wrapped either throw would silently
// un-fix the crash (AUD-A5a-003 / FW1-D). xunit's Assert.ThrowsAsync<T>
// checks the exact runtime type, not "is a", so it is the right assertion
// here — a subclass would fail these tests too.
//
// Real-IO over a temp directory (no mocks), same pattern as
// LoombreServiceHost.Tests/PayloadExtractorTests.cs: Discovery.ReadAsync's
// baseDirOverride parameter (Discovery.cs) is the test seam, the same
// injected-dependency idiom as IpcClient's HttpMessageHandler parameter.

using Loombre.Tray.Ipc;
using System.Text.Json;
using Xunit;

namespace Loombre.Tray.Tests;

public sealed class DiscoveryTests : IDisposable
{
    private readonly DirectoryInfo _root = Directory.CreateTempSubdirectory("loombre-discovery-test-");

    public void Dispose() => _root.Delete(recursive: true);

    [Fact]
    public async Task ReadAsync_throws_exactly_JsonException_on_a_torn_discovery_file()
    {
        // What a poll lands on mid-write during a server restart: valid
        // JSON up to the point the writer was cut off — not empty, not
        // well-formed, just torn.
        await File.WriteAllTextAsync(
            Path.Combine(_root.FullName, Transport.DiscoveryFilename),
            """{"port":54871,"host":"127.0.0""");

        await Assert.ThrowsAsync<JsonException>(
            () => Discovery.ReadAsync(baseDirOverride: _root.FullName));
    }

    [Fact]
    public async Task ReadAsync_throws_exactly_InvalidOperationException_on_an_empty_token_file()
    {
        await File.WriteAllTextAsync(
            Path.Combine(_root.FullName, Transport.DiscoveryFilename),
            """{"port":54871,"host":"127.0.0.1","pid":4821,"startedAtMs":1800000000000}""");
        await File.WriteAllTextAsync(Path.Combine(_root.FullName, Transport.TokenFilename), string.Empty);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => Discovery.ReadAsync(baseDirOverride: _root.FullName));
    }
}
