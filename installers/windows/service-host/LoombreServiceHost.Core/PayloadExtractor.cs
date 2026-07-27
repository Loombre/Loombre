// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost.Core/PayloadExtractor.cs
//
// WHY THIS EXISTS: the MSI cannot install the five big payload trees
// (server, worker, web, node, pg) file-by-file — the first real
// `wix build` (diag run 30219204709) hit WIX7502: 84,305 per-file
// Components against MSI's hard 65,536 ceiling. So build-msi.mjs ships
// them as ONE payload.zip inside the MSI, and this extractor materializes
// the trees under the install folder before the wrapped child process
// first starts (LoombreHostedService.OnStart calls this when Services.wxs
// passes --extract-zip/--extract-to).
//
// Design constraints, each load-bearing:
//   - Both Windows services (LoombreServer, LoombreWorker) run this same
//     code and MSI may start them near-simultaneously — a named mutex
//     serializes extraction; the loser then sees the winner's marker and
//     skips. "Local\" scope suffices: both services live in session 0,
//     and tests share one session too.
//   - The marker file (MarkerFileName, in the destination root) records
//     the SHA-256 of the zip that was last extracted. Marker matches
//     current zip → skip (idempotent restarts). Marker differs → a
//     MajorUpgrade replaced payload.zip → re-extract.
//   - Before re-extracting, the zip's own top-level entries are DELETED
//     from the destination: ZipFile.ExtractToDirectory(overwrite) replaces
//     files the new zip ships but never removes files only the OLD payload
//     shipped, and a version-mixed tree is far worse than a slower
//     re-extract. Only the zip's own top-level names are touched — the
//     destination root also holds MSI-managed dirs (ffmpeg/, svc/, tray/,
//     payload/) this must never sweep.
//   - Extraction failure throws: the caller (service OnStart) must fail
//     loudly rather than spawn a child against a half-materialized tree.
//     ZipFile.ExtractToDirectory already rejects zip-slip entries that
//     would escape the destination.

using System.IO.Compression;
using System.Security.Cryptography;

namespace Loombre.ServiceHost;

public static class PayloadExtractor
{
    public const string MarkerFileName = ".loombre-payload.sha256";
    private const string MutexName = @"Local\LoombrePayloadExtract";

    /// <summary>
    /// Extracts <paramref name="zipPath"/> into <paramref name="destDir"/>
    /// unless the marker shows this exact zip is already extracted.
    /// Returns true if an extraction ran, false on a marker-match skip.
    /// </summary>
    public static bool ExtractIfNeeded(string zipPath, string destDir, Action<string> log)
    {
        if (!File.Exists(zipPath))
        {
            throw new FileNotFoundException(
                $"payload zip not found at '{zipPath}' — expected to be installed by the MSI (Files.wxs PayloadFiles).",
                zipPath);
        }

        using var mutex = new Mutex(initiallyOwned: false, MutexName);
        var owned = false;
        try
        {
            owned = mutex.WaitOne(TimeSpan.FromMinutes(10));
        }
        catch (AbandonedMutexException)
        {
            // A previous holder died mid-extraction. The wait DID acquire
            // the mutex; the marker logic below decides whether the
            // half-done work needs redoing (it does: no marker was written).
            owned = true;
        }
        if (!owned)
        {
            throw new TimeoutException(
                "timed out waiting for another LoombreServiceHost instance to finish extracting the payload.");
        }

        try
        {
            var zipHash = Sha256Hex(zipPath);
            var markerPath = Path.Combine(destDir, MarkerFileName);
            if (File.Exists(markerPath)
                && string.Equals(File.ReadAllText(markerPath).Trim(), zipHash, StringComparison.OrdinalIgnoreCase))
            {
                log($"payload already extracted (marker matches sha256 {zipHash[..12]}…) — skipping extraction");
                return false;
            }

            Directory.CreateDirectory(destDir);
            if (File.Exists(markerPath))
            {
                File.Delete(markerPath);
            }
            foreach (var top in TopLevelEntries(zipPath))
            {
                var topPath = Path.Combine(destDir, top);
                if (Directory.Exists(topPath))
                {
                    log($"removing stale payload tree '{top}' before re-extraction");
                    Directory.Delete(topPath, recursive: true);
                }
                else if (File.Exists(topPath))
                {
                    File.Delete(topPath);
                }
            }

            log($"extracting payload '{zipPath}' -> '{destDir}'");
            ZipFile.ExtractToDirectory(zipPath, destDir, overwriteFiles: true);
            File.WriteAllText(markerPath, zipHash);
            log("payload extraction complete");
            return true;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static IReadOnlyCollection<string> TopLevelEntries(string zipPath)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var tops = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            var normalized = entry.FullName.Replace('\\', '/').TrimStart('/');
            var separatorIndex = normalized.IndexOf('/');
            var top = separatorIndex < 0 ? normalized : normalized[..separatorIndex];
            if (top.Length > 0)
            {
                tops.Add(top);
            }
        }
        return tops;
    }

    private static string Sha256Hex(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
