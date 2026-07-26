// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/TrayApplicationContext.cs
//
// Owns the NotifyIcon + its context menu + the status-poll timer. Talks to
// the server/worker pair EXCLUSIVELY through Loombre.Tray.Ipc's IpcClient —
// this class is Windows-UI plumbing only, deliberately thin, so the actual
// contract logic stays in the testable (headless) Loombre.Tray.Ipc project.
//
// Menu surface per the mission brief: status, Open Loombre (GET
// open-web-target -> launch browser), Start/Stop server (POSTs),
// Reveal crash files (GET crash-files -> explorer /select), version +
// IPC-contract-version mismatch notice.

using System.Diagnostics;
using Loombre.Tray.Ipc;
// The poll timer must be the WinForms (UI-thread) Timer — Tick handlers
// touch NotifyIcon/menu state directly. The alias disambiguates it from
// System.Threading.Timer, which the SDK's implicit usings also import.
using Timer = System.Windows.Forms.Timer;

namespace Loombre.Tray;

public sealed class TrayApplicationContext : ApplicationContext
{
    // P4.11 (single-sourced version): build-msi.mjs passes
    // -p:Version=<root package.json version> to `dotnet publish` so this
    // reads the SAME version apps/server/System.Info exposes, rather than
    // an independently-hand-bumped tray version — see that script's
    // header for the exact invocation. Falls back to the assembly's own
    // metadata if unset (e.g. a bare `dotnet build` outside build-msi.mjs).
    private static readonly string TrayVersion =
        typeof(TrayApplicationContext).Assembly.GetName().Version?.ToString() ?? "0.0.0";

    private readonly NotifyIcon _icon;
    private readonly Timer _pollTimer;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _startStopItem;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _versionItem;

    private IpcStatusResponse? _lastStatus;
    private bool _pollInFlight;

    public TrayApplicationContext()
    {
        _statusItem = new ToolStripMenuItem("Loombre — checking…") { Enabled = false };
        _openItem = new ToolStripMenuItem("Open Loombre", null, OnOpenClicked) { Enabled = false };
        _startStopItem = new ToolStripMenuItem("Start server", null, OnStartStopClicked) { Enabled = false };
        var revealCrashItem = new ToolStripMenuItem("Reveal crash files", null, OnRevealCrashClicked);
        _versionItem = new ToolStripMenuItem($"Loombre Tray v{TrayVersion}") { Enabled = false };
        var exitItem = new ToolStripMenuItem("Exit", null, (_, _) => ExitThread());

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_openItem);
        menu.Items.Add(_startStopItem);
        menu.Items.Add(revealCrashItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_versionItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _icon = new NotifyIcon
        {
            Icon = TrayIcons.For(TrayIconState.Unknown),
            Text = "Loombre",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _icon.DoubleClick += (_, _) => OnOpenClicked(this, EventArgs.Empty);

        _pollTimer = new Timer { Interval = 3000 };
        _pollTimer.Tick += async (_, _) => await PollAsync().ConfigureAwait(true);
        _pollTimer.Start();

        _ = PollAsync();
    }

    private async Task PollAsync()
    {
        if (_pollInFlight)
        {
            return;
        }
        _pollInFlight = true;
        try
        {
            var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
            using var client = new IpcClient(baseAddress, token);
            var status = await client.GetStatusAsync().ConfigureAwait(true);
            _lastStatus = status;
            Render(status);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Discovery files absent/unreadable — server/worker not
            // installed-and-run yet this boot, or a permissions problem
            // (see Discovery.cs's header for the 0600-vs-Windows-ACL note).
            RenderUnreachable("Loombre server not detected");
        }
        catch (IpcException ex)
        {
            RenderUnreachable($"Loombre IPC error: {ex.Body?.Title ?? ex.Message}");
        }
        catch (HttpRequestException)
        {
            // Discovery file present but nothing is listening on that port
            // — e.g. a stale file surviving an unclean shutdown.
            RenderUnreachable("Loombre server not responding");
        }
        finally
        {
            _pollInFlight = false;
        }
    }

    private void Render(IpcStatusResponse status)
    {
        var serverState = status.Server.State;
        _icon.Icon = TrayIcons.For(ToTrayIconState(serverState));
        _icon.Text = Truncate($"Loombre — server {serverState}, worker {status.Worker.State}");

        _statusItem.Text = $"Server: {serverState}   Worker: {status.Worker.State}";
        _openItem.Enabled = status.WebUrl is not null;
        _startStopItem.Enabled = true;
        _startStopItem.Text = serverState == ProcessStates.Running ? "Stop server" : "Start server";

        if (status.IpcContractVersion != ContractVersion.ControllerIpcContractVersion)
        {
            // Version-negotiation per status.ts's own header comment: this
            // tray build is newer/older than the server/worker pair it is
            // talking to — surface it rather than silently trusting a
            // field shape that pair might not actually have.
            _versionItem.Text =
                $"Loombre Tray v{TrayVersion} — IPC contract mismatch (tray v{ContractVersion.ControllerIpcContractVersion}, server v{status.IpcContractVersion})";
        }
        else
        {
            _versionItem.Text = $"Loombre Tray v{TrayVersion} (server {status.Server.Version})";
        }
    }

    private void RenderUnreachable(string message)
    {
        _lastStatus = null;
        _icon.Icon = TrayIcons.For(TrayIconState.Unreachable);
        _icon.Text = Truncate($"Loombre — {message}");
        _statusItem.Text = message;
        _openItem.Enabled = false;
        _startStopItem.Enabled = false;
    }

    private static TrayIconState ToTrayIconState(string serverState)
    {
        if (serverState == ProcessStates.Running) return TrayIconState.Running;
        if (serverState == ProcessStates.Starting || serverState == ProcessStates.Stopping) return TrayIconState.Transitioning;
        if (serverState == ProcessStates.Crashed) return TrayIconState.Crashed;
        return TrayIconState.Stopped;
    }

    private async void OnOpenClicked(object? sender, EventArgs e)
    {
        try
        {
            var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
            using var client = new IpcClient(baseAddress, token);
            var target = await client.GetOpenWebTargetAsync().ConfigureAwait(true);
            // The contract explicitly leaves launching a browser to the
            // controller (open-web-target.ts's header) — this is that step.
            Process.Start(new ProcessStartInfo(target.Url) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
        {
            ShowWarning(ex);
        }
    }

    private async void OnStartStopClicked(object? sender, EventArgs e)
    {
        try
        {
            var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
            using var client = new IpcClient(baseAddress, token);
            var wantStart = _lastStatus?.Server.State != ProcessStates.Running;
            if (wantStart)
            {
                await client.StartServerAsync().ConfigureAwait(true);
            }
            else
            {
                await client.StopServerAsync().ConfigureAwait(true);
            }
            await PollAsync().ConfigureAwait(true);
        }
        catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
        {
            ShowWarning(ex);
        }
    }

    private async void OnRevealCrashClicked(object? sender, EventArgs e)
    {
        try
        {
            var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
            using var client = new IpcClient(baseAddress, token);
            var files = await client.GetCrashFilesAsync().ConfigureAwait(true);
            if (files.Files.Count == 0)
            {
                MessageBox.Show("No crash files found.", "Loombre", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var newest = files.Files.OrderByDescending(f => f.MtimeMs).First();
            Process.Start("explorer.exe", $"/select,\"{newest.Path}\"");
        }
        catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
        {
            ShowWarning(ex);
        }
    }

    private static void ShowWarning(Exception ex)
    {
        var message = ex is IpcException ipcEx
            ? ipcEx.Body?.Detail ?? ipcEx.Message
            : "Loombre server is not reachable.";
        MessageBox.Show(message, "Loombre", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private static string Truncate(string s) => s.Length <= 127 ? s : string.Concat(s.AsSpan(0, 124), "...");

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pollTimer.Dispose();
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
