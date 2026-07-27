// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost.Tests/WindowsCommandLineTests.cs
//
// Pins the CommandLineToArgvW-inverse quoting rules RestrictedProcess.cs
// depends on. Every expectation below is the documented parser behavior
// (quotes for spaces, 2n backslashes before a closing quote, 2n+1 before
// an embedded escaped quote) — a regression here corrupts child argv
// silently, which for the restricted server spawn means a node.exe that
// starts with the wrong main.js path or a mangled --flag vector.

using Loombre.ServiceHost;
using Xunit;

namespace Loombre.ServiceHost.Tests;

public class WindowsCommandLineTests
{
    [Fact]
    public void Plain_arguments_stay_unquoted()
    {
        Assert.Equal(@"node.exe dist\main.js --flag", WindowsCommandLine.Build("node.exe", ["dist\\main.js", "--flag"]));
    }

    [Fact]
    public void Arguments_with_spaces_are_quoted()
    {
        Assert.Equal(
            "\"C:\\Program Files\\Loombre\\node\\node.exe\" \"C:\\Program Files\\Loombre\\server\\dist\\main.js\"",
            WindowsCommandLine.Build(@"C:\Program Files\Loombre\node\node.exe", [@"C:\Program Files\Loombre\server\dist\main.js"]));
    }

    [Fact]
    public void Trailing_backslashes_inside_quotes_are_doubled()
    {
        // "dir\" would escape the closing quote — the parser needs "dir\\".
        Assert.Equal("exe \"C:\\some dir\\\\\"", WindowsCommandLine.Build("exe", ["C:\\some dir\\"]));
    }

    [Fact]
    public void Embedded_quotes_are_escaped()
    {
        Assert.Equal("exe \"say \\\"hi\\\"\"", WindowsCommandLine.Build("exe", ["say \"hi\""]));
    }

    [Fact]
    public void Backslashes_before_an_embedded_quote_are_doubled_plus_one()
    {
        // value: a\"b  → quoted as "a\\\"b" (2n+1 = 3 backslashes).
        Assert.Equal("exe \"a\\\\\\\"b\"", WindowsCommandLine.Build("exe", ["a\\\"b"]));
    }

    [Fact]
    public void Empty_argument_becomes_empty_quotes()
    {
        Assert.Equal("exe \"\"", WindowsCommandLine.Build("exe", [""]));
    }
}
