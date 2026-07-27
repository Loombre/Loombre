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

        var options = ServiceOptions.Parse(args);
        ServiceBase.Run(new LoombreHostedService(options));
        return 0;
    }
}
