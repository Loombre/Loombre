// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/service-host/LoombreServiceHost/LoombreHostedService.cs
//
// The ServiceBase that actually implements SCM's protocol on our behalf
// (StartServiceCtrlDispatcher / SetServiceStatus, all handled by the
// base class) and supervises exactly one child process.
//
// GRACEFUL STOP MECHANISM (the reason this whole project exists — see
// installers/windows/msi/Services.wxs's header for the "why not just
// node.exe" evidence trail):
//
// Windows has no POSIX SIGTERM. The child (node.exe) is a console-
// subsystem process; Node's own win32 build DOES translate a received
// CTRL_BREAK_EVENT into the 'SIGBREAK' process event
// (https://nodejs.org/api/process.html documents SIGBREAK as
// Windows-specific), which is the nearest thing to a graceful-shutdown
// signal available on this platform. Two things have to be true for that
// delivery to actually reach the child:
//
//   1. GenerateConsoleCtrlEvent can only signal a console GROUP the
//      CALLING process is itself attached to. A Windows Service normally
//      has no console at all, so before signalling we FreeConsole() (in
//      case we somehow have one) then AttachConsole(childPid) to borrow
//      the child's, call SetConsoleCtrlHandler(null, true) so THIS
//      process ignores the very event it's about to broadcast, fire the
//      event at group 0 (= every process attached to that console), then
//      FreeConsole() again to detach. This dance (not a single API call)
//      is the actual documented mechanism for a console-less parent to
//      signal a console-subsystem child — see NativeMethods.cs's header
//      for the "untested on real Windows" note.
//   2. .NET 8 cannot put the child in its own console process group:
//      ProcessStartInfo.CreateNewProcessGroup exists only on .NET 9+
//      (the first-ever Windows compile of this project — diag run
//      30218015372 — caught the CS0117), and .NET 8 is this repo's
//      Active-LTS line. Group-targeted delivery (group id = child pid,
//      which would cleanly exclude this wrapper) is therefore not
//      available; the group-0 broadcast plus the handler-ignore above is
//      the .NET 8 mechanism. Revisit when the repo's .NET line moves
//      past 8 (the property is the cleaner form), or if Wave-3 Windows
//      hardening lands a P/Invoked CreateProcess with
//      CREATE_NEW_PROCESS_GROUP.
//
// If AttachConsole fails (child never got a console for some reason, or
// already exited) or the child does not exit within
// ServiceOptions.GracefulStopTimeoutMs, this wrapper kills the entire
// child process tree so SCM's own (much shorter, non-configurable) stop
// timeout is never what has to clean up.
//
// apps/server and apps/worker do not yet have a win32 process.on('SIGBREAK')
// handler (STATE.md P4.14 added POSIX SIGTERM only) — until that lands,
// every Windows stop takes the timeout-then-kill path below rather than a
// true graceful drain. Flagged in the I3 report; not this lane's file to
// fix (apps/server/src, apps/worker/src are outside installers/windows/**).

using System.Diagnostics;
using System.ServiceProcess;

namespace Loombre.ServiceHost;

public sealed class LoombreHostedService : ServiceBase
{
    private readonly ServiceOptions _options;
    private Process? _child;
    private StreamWriter? _log;
    private volatile bool _stopRequested;

    public LoombreHostedService(ServiceOptions options)
    {
        _options = options;
        ServiceName = options.ServiceName;
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        var logDir = Path.GetDirectoryName(_options.LogFilePath);
        if (!string.IsNullOrEmpty(logDir))
        {
            Directory.CreateDirectory(logDir);
        }
        _log = new StreamWriter(_options.LogFilePath, append: true) { AutoFlush = true };

        if (_options.ExtractZipPath is not null && _options.ExtractToDir is not null)
        {
            // First boot after install/upgrade extracts the multi-hundred-MB
            // payload.zip (see PayloadExtractor's header for why the MSI
            // cannot ship these trees as files). SCM's default start-pending
            // window (~30s) is too short for that on a slow disk — ask for
            // more BEFORE starting; a marker-match skip costs one hash pass.
            RequestAdditionalTime(180_000);
            PayloadExtractor.ExtractIfNeeded(_options.ExtractZipPath, _options.ExtractToDir, Log);
        }

        Log($"starting: \"{_options.ExecutablePath}\" {string.Join(' ', _options.Arguments)}");

        var psi = new ProcessStartInfo
        {
            FileName = _options.ExecutablePath,
            WorkingDirectory = _options.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in _options.Arguments)
        {
            psi.ArgumentList.Add(a);
        }

        ApplyEnvFile(psi, _options.EnvFilePath);

        var child = new Process { StartInfo = psi, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, e) => { if (e.Data is not null) Log(e.Data); };
        child.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log(e.Data); };
        child.Exited += OnChildExited;

        child.Start();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        _child = child;
    }

    private void OnChildExited(object? sender, EventArgs e)
    {
        if (_child is null) return;
        Log($"child exited with code {_child.ExitCode}");
        if (!_stopRequested)
        {
            // The child died on its own (crash, or it self-terminated) —
            // take the whole service down with it rather than reporting
            // SERVICE_RUNNING over an empty shell. SCM's own service-
            // recovery options (configurable outside this wrapper via
            // `sc failure`) govern whether/how it gets restarted.
            Stop();
        }
    }

    protected override void OnStop() => StopChild();

    protected override void OnShutdown() => StopChild();

    private void StopChild()
    {
        _stopRequested = true;
        var child = _child;
        if (child is null || child.HasExited)
        {
            return;
        }

        Log("stop requested: attempting graceful shutdown via CTRL_BREAK_EVENT");
        var signalled = TrySendCtrlBreak(child.Id);
        if (!signalled)
        {
            Log("CTRL_BREAK_EVENT delivery was not possible (AttachConsole failed) — falling back to timeout+kill");
        }

        if (!child.WaitForExit(_options.GracefulStopTimeoutMs))
        {
            Log($"child did not exit within {_options.GracefulStopTimeoutMs}ms — killing process tree");
            try
            {
                child.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Already exited between the WaitForExit timeout and here.
            }
            child.WaitForExit(5_000);
        }

        Log("stopped");
        _log?.Flush();
    }

    private static bool TrySendCtrlBreak(int childProcessId)
    {
        NativeMethods.FreeConsole();
        try
        {
            if (!NativeMethods.AttachConsole((uint)childProcessId))
            {
                return false;
            }
            try
            {
                // Ignore the break signal in THIS process — we are about
                // to broadcast it to the group we just attached to, and we
                // are not the intended recipient.
                NativeMethods.SetConsoleCtrlHandler(null, true);
                return NativeMethods.GenerateConsoleCtrlEvent(NativeMethods.CTRL_BREAK_EVENT, 0);
            }
            finally
            {
                NativeMethods.FreeConsole();
                NativeMethods.SetConsoleCtrlHandler(null, false);
            }
        }
        catch (Exception)
        {
            // Never let a signalling failure take the WHOLE stop sequence
            // down with it — the timeout+kill fallback below still runs.
            return false;
        }
    }

    private static void ApplyEnvFile(ProcessStartInfo psi, string? envFilePath)
    {
        if (envFilePath is null || !File.Exists(envFilePath))
        {
            return;
        }
        foreach (var rawLine in File.ReadAllLines(envFilePath))
        {
            var trimmed = rawLine.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#'))
            {
                continue;
            }
            var idx = trimmed.IndexOf('=');
            if (idx <= 0)
            {
                continue;
            }
            psi.Environment[trimmed[..idx]] = trimmed[(idx + 1)..];
        }
    }

    private void Log(string message) => _log?.WriteLine($"{DateTime.UtcNow:O} {message}");

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _child?.Dispose();
            _log?.Dispose();
        }
        base.Dispose(disposing);
    }
}
