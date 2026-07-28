// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/Program.cs
//
// Entrypoint. All argument parsing lives in ServiceOptions (pure, unit
// tested — see LoombreServiceHost.Tests) so this file stays a one-liner.

using System.ServiceProcess;

namespace Loombre.ServiceHost;

internal static class Program
{
    private static int Main(string[] args)
    {
        // MSI install-time mode (Package.wxs's ca.ExtractPayload, deferred
        // after InstallFiles): extract the archived payload and exit — no
        // SCM involved. The service path below keeps the same extraction
        // as a first-start SELF-HEAL (marker match makes it a cheap no-op
        // after a healthy install).
        if (args.Length == 3 && args[0] == "--extract-cli")
        {
            try
            {
                PayloadExtractor.ExtractIfNeeded(args[1], args[2], Console.WriteLine);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"payload extraction failed: {ex}");
                return 1;
            }
        }

        // A bad/empty command line is a USAGE error, not a crash. Left
        // unhandled, ServiceOptions.Parse's ArgumentException propagated out
        // of Main and .NET terminated the process with 0xE0434352 — which
        // Windows dutifully logged as an APPCRASH in the Application event
        // log and captured a full WER minidump for. The v0.9.0-rc.1 field
        // report contains two such dumps from nothing worse than the
        // executable being launched with no arguments (double-clicked while
        // looking around the install directory). Those entries are pure
        // noise sitting in the same event log an operator searches when
        // something has genuinely broken, so: print what was wrong, print
        // how it is meant to be invoked, exit non-zero, generate no dump.
        ServiceOptions options;
        try
        {
            options = ServiceOptions.Parse(args);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.WriteLine();
            Console.Error.WriteLine(
                "LoombreServiceHost is not meant to be started by hand — the Loombre installer registers it "
                    + "with the Windows Service Control Manager, which supplies these arguments. Manage the "
                    + "services instead:");
            Console.Error.WriteLine("    sc start LoombreServer   (or Services.msc / Get-Service Loombre*)");
            Console.Error.WriteLine();
            Console.Error.WriteLine(
                "Usage: LoombreServiceHost --name <service> --exe <path> --cwd <dir> --log <file> "
                    + "[--arg <a>]... [--envfile <file>] [--stop-timeout-ms <n>] [--extract-zip <zip> --extract-to <dir>] "
                    + "[--spawn-restricted]");
            Console.Error.WriteLine("       LoombreServiceHost --extract-cli <zip> <destination>");
            return 2;
        }

        ServiceBase.Run(new LoombreHostedService(options));
        return 0;
    }
}
