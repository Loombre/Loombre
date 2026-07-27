// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost.Core/WindowsCommandLine.cs
//
// The CommandLineToArgvW INVERSE — turns an exe + argument list into one
// command-line string that Windows' standard parser splits back into
// exactly those arguments (quote when needed; double backslashes before a
// quote; escape embedded quotes). Lives in Core (not the exe) so the
// portable test suite can pin the quoting rules: RestrictedProcess.cs
// builds its CreateProcessAsUser command line with this, and a quoting bug
// there would corrupt every child argv silently.

using System.Text;

namespace Loombre.ServiceHost;

public static class WindowsCommandLine
{
    public static string Build(string fileName, IEnumerable<string> arguments)
    {
        var builder = new StringBuilder();
        AppendQuoted(builder, fileName);
        foreach (var argument in arguments)
        {
            builder.Append(' ');
            AppendQuoted(builder, argument);
        }
        return builder.ToString();
    }

    private static void AppendQuoted(StringBuilder builder, string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            builder.Append(value);
            return;
        }
        builder.Append('"');
        var backslashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\')
            {
                backslashes++;
                continue;
            }
            if (ch == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            builder.Append(ch);
            backslashes = 0;
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
    }
}
