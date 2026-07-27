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
    int GracefulStopTimeoutMs,
    // Both-or-neither pair (Parse enforces it): the MSI ships the five big
    // payload trees as ONE archived file (WIX7502 — 84,305 per-file
    // components vs MSI's hard 65,536 ceiling, diag run 30219204709), and
    // whichever service starts first extracts it — see PayloadExtractor.
    string? ExtractZipPath = null,
    string? ExtractToDir = null,
    // --spawn-restricted: launch the child with a CreateRestrictedToken
    // that DISABLES the Administrators group SID — pg_ctl's own technique.
    // Required for LoombreServer: it supervises an embedded postgres.exe,
    // which hard-refuses to run from a token with admin privileges, and a
    // LocalSystem service's direct spawn inherits exactly such a token.
    // See RestrictedProcess.cs for the mechanism and what SYSTEM file
    // access survives (user-SID ACEs do; Administrators-granted ACEs
    // become deny-only).
    bool SpawnRestricted = false)
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
        string? extractZip = null;
        string? extractTo = null;
        var spawnRestricted = false;
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
                case "--extract-zip":
                    extractZip = RequireValue(args, ref i, "--extract-zip");
                    break;
                case "--extract-to":
                    extractTo = RequireValue(args, ref i, "--extract-to");
                    break;
                case "--spawn-restricted":
                    spawnRestricted = true;
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

        if ((extractZip is null) != (extractTo is null))
        {
            throw new ArgumentException(
                "--extract-zip and --extract-to must be passed together (both or neither) — " +
                "see installers/windows/msi/Services.wxs's <ServiceInstall Arguments=\"…\">.");
        }

        return new ServiceOptions(
            serviceName!, exePath!, childArgs, cwd!, logPath!, envFile, stopTimeoutMs, extractZip, extractTo,
            spawnRestricted);
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
