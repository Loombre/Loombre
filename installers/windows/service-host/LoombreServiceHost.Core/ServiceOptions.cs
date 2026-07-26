// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/ServiceOptions.cs
//
// Parses the flat "--flag value" argument vector
// installers/windows/msi/Services.wxs's <ServiceInstall Arguments="…">
// hands us. Deliberately dumb: by the time Main(string[] args) sees this
// array, .NET has ALREADY applied Windows' standard command-line
// splitting/unquoting (the same algorithm CommandLineToArgvW uses) to
// whatever SCM launched us with — there is no raw quoting to re-parse or
// get wrong here, only flag lookup. See Services.wxs's header for the
// quoting design on the WiX side.

namespace Loombre.ServiceHost;

/// <summary>
/// Fully-resolved configuration for one LoombreServiceHost-wrapped service
/// instance. Two Windows services (LoombreServer, LoombreWorker — see
/// installers/windows/msi/Services.wxs) run the SAME LoombreServiceHost.exe
/// binary, each with its own ServiceOptions supplied on its own command
/// line — this type has no knowledge of which one it is beyond what its
/// own args say.
/// </summary>
public sealed record ServiceOptions(
    string ServiceName,
    string ExecutablePath,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    string LogFilePath,
    string? EnvFilePath,
    int GracefulStopTimeoutMs)
{
    /// <summary>Default used when --stop-timeout-ms is omitted. Kept
    /// generous (worker jobs — scan/transcode — may need longer to reach a
    /// safe checkpoint than the server's request handlers do); each
    /// ServiceInstall in Services.wxs passes an explicit value rather than
    /// relying on this default, so this only matters for a manual/testing
    /// invocation.</summary>
    public const int DefaultGracefulStopTimeoutMs = 10_000;

    public static ServiceOptions Parse(string[] args)
    {
        string? serviceName = null;
        string? exePath = null;
        var childArgs = new List<string>();
        string? cwd = null;
        string? logPath = null;
        string? envFile = null;
        var stopTimeoutMs = DefaultGracefulStopTimeoutMs;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name":
                    serviceName = RequireValue(args, ref i, "--name");
                    break;
                case "--exe":
                    exePath = RequireValue(args, ref i, "--exe");
                    break;
                case "--arg":
                    childArgs.Add(RequireValue(args, ref i, "--arg"));
                    break;
                case "--cwd":
                    cwd = RequireValue(args, ref i, "--cwd");
                    break;
                case "--log":
                    logPath = RequireValue(args, ref i, "--log");
                    break;
                case "--envfile":
                    envFile = RequireValue(args, ref i, "--envfile");
                    break;
                case "--stop-timeout-ms":
                    var raw = RequireValue(args, ref i, "--stop-timeout-ms");
                    if (!int.TryParse(raw, out stopTimeoutMs) || stopTimeoutMs <= 0)
                    {
                        throw new ArgumentException($"--stop-timeout-ms must be a positive integer, got '{raw}'.");
                    }
                    break;
                default:
                    throw new ArgumentException($"Unrecognized LoombreServiceHost argument: '{args[i]}'.");
            }
        }

        var missing = new List<string>();
        if (serviceName is null) missing.Add("--name");
        if (exePath is null) missing.Add("--exe");
        if (cwd is null) missing.Add("--cwd");
        if (logPath is null) missing.Add("--log");
        if (missing.Count > 0)
        {
            throw new ArgumentException(
                $"LoombreServiceHost is missing required argument(s): {string.Join(", ", missing)} " +
                "(see installers/windows/msi/Services.wxs's <ServiceInstall Arguments=\"…\">).");
        }

        return new ServiceOptions(serviceName!, exePath!, childArgs, cwd!, logPath!, envFile, stopTimeoutMs);
    }

    private static string RequireValue(string[] args, ref int i, string flag)
    {
        if (i + 1 >= args.Length)
        {
            throw new ArgumentException($"'{flag}' requires a value.");
        }
        i++;
        return args[i];
    }
}
