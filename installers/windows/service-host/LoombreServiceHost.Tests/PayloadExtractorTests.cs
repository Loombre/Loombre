// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost.Tests/PayloadExtractorTests.cs
//
// Real-IO tests over temp directories (no mocks): PayloadExtractor is the
// only thing standing between the MSI's single payload.zip and a runnable
// install tree, so these prove the actual contract — extract, skip when
// current, fully replace (including DELETING files the new payload
// dropped) after an upgrade — on every OS the test suite runs on.

using System.IO.Compression;
using Loombre.ServiceHost;
using Xunit;

namespace Loombre.ServiceHost.Tests;

public sealed class PayloadExtractorTests : IDisposable
{
    private readonly DirectoryInfo _root = Directory.CreateTempSubdirectory("loombre-extract-test-");
    private readonly List<string> _logLines = [];

    private string ZipPath => Path.Combine(_root.FullName, "payload.zip");
    private string DestDir => Path.Combine(_root.FullName, "install");

    public void Dispose() => _root.Delete(recursive: true);

    private void BuildZip(params (string EntryPath, string Content)[] entries)
    {
        File.Delete(ZipPath);
        using var archive = ZipFile.Open(ZipPath, ZipArchiveMode.Create);
        foreach (var (entryPath, content) in entries)
        {
            using var writer = new StreamWriter(archive.CreateEntry(entryPath).Open());
            writer.Write(content);
        }
    }

    private bool Extract() => PayloadExtractor.ExtractIfNeeded(ZipPath, DestDir, _logLines.Add);

    [Fact]
    public void Extracts_then_skips_while_the_zip_is_unchanged()
    {
        BuildZip(("server/dist/main.js", "console.log('server');"), ("pg/bin/postgres", "elephant"));

        Assert.True(Extract());
        Assert.Equal("console.log('server');", File.ReadAllText(Path.Combine(DestDir, "server", "dist", "main.js")));
        Assert.Equal("elephant", File.ReadAllText(Path.Combine(DestDir, "pg", "bin", "postgres")));
        Assert.True(File.Exists(Path.Combine(DestDir, PayloadExtractor.MarkerFileName)));

        Assert.False(Extract());
        Assert.Contains(_logLines, line => line.Contains("skipping extraction"));
    }

    [Fact]
    public void Reextracts_a_changed_zip_and_deletes_files_the_new_payload_dropped()
    {
        BuildZip(("server/dist/main.js", "v1"), ("server/dist/only-in-v1.js", "gone in v2"));
        Assert.True(Extract());

        BuildZip(("server/dist/main.js", "v2"));
        Assert.True(Extract());

        Assert.Equal("v2", File.ReadAllText(Path.Combine(DestDir, "server", "dist", "main.js")));
        // The load-bearing assertion: overwrite-extraction alone would have
        // left only-in-v1.js behind as a version-mixed tree.
        Assert.False(File.Exists(Path.Combine(DestDir, "server", "dist", "only-in-v1.js")));
    }

    [Fact]
    public void Reextraction_never_touches_sibling_dirs_outside_the_zip_tops()
    {
        // The destination root is the INSTALL FOLDER — it also holds
        // MSI-managed trees (ffmpeg/, svc/, tray/, payload/) that stale-tree
        // cleanup must never sweep.
        BuildZip(("server/dist/main.js", "v1"));
        Assert.True(Extract());
        var msiOwned = Path.Combine(DestDir, "ffmpeg", "ffmpeg.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(msiOwned)!);
        File.WriteAllText(msiOwned, "not yours to delete");

        BuildZip(("server/dist/main.js", "v2"));
        Assert.True(Extract());

        Assert.Equal("not yours to delete", File.ReadAllText(msiOwned));
    }

    [Fact]
    public void A_missing_zip_throws_rather_than_silently_continuing()
    {
        Assert.Throws<FileNotFoundException>(
            () => PayloadExtractor.ExtractIfNeeded(Path.Combine(_root.FullName, "nope.zip"), DestDir, _ => { }));
    }
}
