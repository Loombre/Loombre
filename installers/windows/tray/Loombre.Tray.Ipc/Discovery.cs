// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray.Ipc/Discovery.cs
//
// Reads the two well-known files packages/controller-ipc/src/transport.ts
// documents (IPC_DISCOVERY_FILENAME + IPC_TOKEN_FILENAME) from the
// platform app-data directory. Resolving THAT base directory is
// documented as "the caller's concern" by the TS package itself
// (transport.ts's header, mirroring @loombre/provisioning's absolute-path.ts
// convention) — on Windows that is %ProgramData%\Loombre (docs/PLAN.md
// §11), the SAME directory installers/windows/msi/Directories.wxs creates
// as APPDATAFOLDER.
//
// KNOWN GAP, flagged rather than silently assumed away (see the I3 lane
// report): transport.ts says the token file "MUST be created 0600
// (owner-read/write only)". That is a POSIX file-mode concept; Windows has
// no mode bits, only ACLs, and the process WRITING these files
// (LoombreServer, running as LocalSystem per Services.wxs) is a DIFFERENT
// OS principal than the process reading them here (the tray, running as
// whichever user is interactively logged in — Services.wxs deliberately
// does NOT run the tray as LocalSystem). A literal "owner-only" ACL
// (SYSTEM + Administrators only) would make the token file unreadable by
// a non-admin tray session, breaking discovery entirely for that common
// case. The correct Windows-side ACL (something like: SYSTEM full control,
// the interactive/Users group READ-only, Everyone/NETWORK denied) is a
// SERVER-side concern — apps/server's controller-ipc file-writing code,
// which does not exist yet as of this build — not something this
// (read-only) class can fix from the reading side.

using System.Text.Json;

namespace Loombre.Tray.Ipc;

public static class Discovery
{
    /// <summary>%ProgramData%\Loombre — the same directory the MSI creates
    /// as APPDATAFOLDER (installers/windows/msi/Directories.wxs) and the
    /// server/worker/provisioning processes write into.</summary>
    public static string AppDataDir =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Loombre");

    public static async Task<(Uri BaseAddress, string Token)> ReadAsync(CancellationToken ct = default)
    {
        var discoveryPath = Path.Combine(AppDataDir, Transport.DiscoveryFilename);
        var tokenPath = Path.Combine(AppDataDir, Transport.TokenFilename);

        IpcDiscoveryFile? file;
        await using (var stream = File.OpenRead(discoveryPath))
        {
            file = await JsonSerializer.DeserializeAsync<IpcDiscoveryFile>(stream, cancellationToken: ct)
                .ConfigureAwait(false);
        }
        if (file is null)
        {
            throw new InvalidOperationException($"{discoveryPath} is empty or not valid JSON.");
        }

        var token = (await File.ReadAllTextAsync(tokenPath, ct).ConfigureAwait(false)).Trim();
        if (token.Length == 0)
        {
            throw new InvalidOperationException($"{tokenPath} is empty.");
        }

        var baseAddress = new Uri($"http://{file.Host}:{file.Port}");
        return (baseAddress, token);
    }

    /// <summary>True if the discovery file's PID still names a live
    /// process — lets a caller tell "server never started this boot" apart
    /// from "server crashed, a stale discovery file was left behind"
    /// without making an HTTP call first (transport.ts's
    /// IpcDiscoveryFile.pid doc comment). Not currently wired into
    /// TrayApplicationContext's poll loop (an unreachable HTTP call already
    /// distinguishes "nothing there" from "something there" well enough
    /// for v1's status text) — exposed for a future finer-grained status
    /// message and exercised directly by IpcClientTests today.</summary>
    public static bool IsProcessAlive(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false; // no such process
        }
    }
}
