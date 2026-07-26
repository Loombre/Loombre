// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost.Tests/ServiceOptionsTests.cs
//
// Fixture args mirror installers/windows/msi/Services.wxs's two
// <ServiceInstall Arguments="…"> strings (LoombreServer / LoombreWorker),
// already command-line-split the way .NET's own Main(string[] args) would
// deliver them — see ServiceOptions.cs's header for why this project never
// re-parses raw quoting itself.

using Loombre.ServiceHost;
using Xunit;

namespace Loombre.ServiceHost.Tests;

public class ServiceOptionsTests
{
    private static readonly string[] ServerArgs =
    [
        "--name", "LoombreServer",
        "--exe", @"C:\Program Files\Loombre\node\node.exe",
        "--arg", @"C:\Program Files\Loombre\server\dist\main.js",
        "--cwd", @"C:\Program Files\Loombre\server",
        "--log", @"C:\ProgramData\Loombre\logs\server.log",
        "--envfile", @"C:\ProgramData\Loombre\data\server.env",
        "--stop-timeout-ms", "10000",
    ];

    [Fact]
    public void Parses_the_LoombreServer_argument_vector()
    {
        var options = ServiceOptions.Parse(ServerArgs);

        Assert.Equal("LoombreServer", options.ServiceName);
        Assert.Equal(@"C:\Program Files\Loombre\node\node.exe", options.ExecutablePath);
        Assert.Single(options.Arguments);
        Assert.Equal(@"C:\Program Files\Loombre\server\dist\main.js", options.Arguments[0]);
        Assert.Equal(@"C:\Program Files\Loombre\server", options.WorkingDirectory);
        Assert.Equal(@"C:\ProgramData\Loombre\logs\server.log", options.LogFilePath);
        Assert.Equal(@"C:\ProgramData\Loombre\data\server.env", options.EnvFilePath);
        Assert.Equal(10_000, options.GracefulStopTimeoutMs);
    }

    [Fact]
    public void Defaults_the_stop_timeout_when_omitted()
    {
        var options = ServiceOptions.Parse(
        [
            "--name", "LoombreWorker",
            "--exe", @"C:\Program Files\Loombre\node\node.exe",
            "--arg", @"C:\Program Files\Loombre\worker\dist\index.js",
            "--cwd", @"C:\Program Files\Loombre\worker",
            "--log", @"C:\ProgramData\Loombre\logs\worker.log",
        ]);

        Assert.Equal(ServiceOptions.DefaultGracefulStopTimeoutMs, options.GracefulStopTimeoutMs);
        Assert.Null(options.EnvFilePath);
    }

    [Fact]
    public void Supports_multiple_repeated_arg_flags_for_a_multi_argument_child()
    {
        var options = ServiceOptions.Parse(
        [
            "--name", "LoombreServer",
            "--exe", @"C:\node\node.exe",
            "--arg", "dist\\main.js",
            "--arg", "--some-flag",
            "--cwd", @"C:\server",
            "--log", @"C:\logs\server.log",
        ]);

        Assert.Equal(2, options.Arguments.Count);
        Assert.Equal("dist\\main.js", options.Arguments[0]);
        Assert.Equal("--some-flag", options.Arguments[1]);
    }

    [Theory]
    [InlineData("--name")]
    [InlineData("--exe")]
    [InlineData("--cwd")]
    [InlineData("--log")]
    public void Throws_when_a_required_flag_is_missing(string missingFlag)
    {
        var args = new List<string>(ServerArgs);
        var index = args.IndexOf(missingFlag);
        args.RemoveRange(index, 2);

        Assert.Throws<ArgumentException>(() => ServiceOptions.Parse([.. args]));
    }

    [Fact]
    public void Throws_on_an_unrecognized_flag()
    {
        Assert.Throws<ArgumentException>(() => ServiceOptions.Parse(["--bogus", "value"]));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-5")]
    [InlineData("not-a-number")]
    public void Throws_on_an_invalid_stop_timeout(string invalidValue)
    {
        Assert.Throws<ArgumentException>(() => ServiceOptions.Parse(
        [
            "--name", "LoombreServer",
            "--exe", @"C:\node\node.exe",
            "--cwd", @"C:\server",
            "--log", @"C:\logs\server.log",
            "--stop-timeout-ms", invalidValue,
        ]));
    }
}
