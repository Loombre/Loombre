// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/Program.cs
//
// Entrypoint. All argument parsing lives in ServiceOptions (pure, unit
// tested — see LoombreServiceHost.Tests) so this file stays a one-liner.

using System.ServiceProcess;

namespace Loombre.ServiceHost;

internal static class Program
{
    private static void Main(string[] args)
    {
        var options = ServiceOptions.Parse(args);
        ServiceBase.Run(new LoombreHostedService(options));
    }
}
