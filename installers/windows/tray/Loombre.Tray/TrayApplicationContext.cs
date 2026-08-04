// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/tray/Loombre.Tray/TrayApplicationContext.cs
//
// Owns the NotifyIcon + its context menu + the status-poll timer. Talks to
// the server/worker pair through Loombre.Tray.Ipc's IpcClient for status/
// stop/open (the FROZEN controller-ipc contract) and through
// ServiceManagerProbe for the one thing that contract deliberately cannot
// do — starting a STOPPED server (IPC_SERVER_START_SEMANTICS). This class
// stays Windows-UI plumbing only; every decision that can be headless
// lives in the testable Loombre.Tray.Ipc project (ServerControl,
// TrayLaunchModes).
//
// Menu surface per the mission brief: status, Open Loombre (GET
// open-web-target -> launch browser), Start/Stop server, Shut down
// Loombre (UAC-elevated whole-stack stop + tray exit — the full kill
// switch), Reveal crash files (GET crash-files -> explorer /select),
// version + IPC-contract-version mismatch notice.

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

    /// <summary>How long the surface-the-web-UI flow waits for the server
    /// to become reachable before giving up. Generous on purpose: a FIRST
    /// service start pays payload-zip extraction + initdb + migrations,
    /// which real-machine rounds have shown can take minutes.</summary>
    private static readonly TimeSpan SurfaceDeadline = TimeSpan.FromSeconds(180);
    private static readonly TimeSpan SurfaceRetryInterval = TimeSpan.FromSeconds(2);

    private readonly NotifyIcon _icon;
    private readonly Timer _pollTimer;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _startStopItem;
    private readonly ToolStripMenuItem _shutdownItem;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _versionItem;
    private readonly SynchronizationContext _uiContext;
    private readonly RegisteredWaitHandle? _openWebWait;

    private IpcStatusResponse? _lastStatus;
    private ServerControlPlan? _lastPlan;
    private bool _pollInFlight;
    private bool _surfaceInFlight;
    private bool _scmStartInFlight;
    private bool _shutdownInFlight;

    public TrayApplicationContext(TrayLaunchMode launchMode, WaitHandle? openWebSignal)
    {
        _statusItem = new ToolStripMenuItem("Loombre — checking…") { Enabled = false };
        _openItem = new ToolStripMenuItem("Open Loombre", null, OnOpenClicked) { Enabled = false };
        _startStopItem = new ToolStripMenuItem("Start Loombre", null, OnStartStopClicked) { Enabled = false };
        // A kill switch must never depend on the thing it kills: enabled
        // regardless of IPC reachability or plan state — the services may
        // well be up while IPC is broken, which is exactly when the user
        // most needs a way to stop everything (the rc "Start server is
        // always grayed out" lesson, applied in the opposite direction).
        _shutdownItem = new ToolStripMenuItem("Shut down Loombre…", null, OnShutdownClicked);
        var revealCrashItem = new ToolStripMenuItem("Reveal crash files", null, OnRevealCrashClicked);
        _versionItem = new ToolStripMenuItem($"Loombre Tray v{TrayVersion}") { Enabled = false };
        var exitItem = new ToolStripMenuItem("Exit", null, (_, _) => ExitThread());

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_openItem);
        menu.Items.Add(_startStopItem);
        menu.Items.Add(_shutdownItem);
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

        // Creating the ContextMenuStrip above installed the WinForms
        // synchronization context on this (STA/UI) thread; captured here
        // so the open-web signal's thread-pool callback can marshal back.
        _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        if (openWebSignal is not null)
        {
            // A second interactive launch (Start Menu click while this
            // instance is live) sets this event instead of showing a
            // second icon — treat it exactly like "the user asked to see
            // Loombre". executeOnlyOnce:false — every later launch
            // signals again.
            _openWebWait = ThreadPool.RegisterWaitForSingleObject(
                openWebSignal,
                (_, _) => _uiContext.Post(OnOpenWebSignal, null),
                state: null,
                Timeout.InfiniteTimeSpan,
                executeOnlyOnce: false);
        }

        _pollTimer = new Timer { Interval = 3000 };
        _pollTimer.Tick += async (_, _) => await PollAsync().ConfigureAwait(true);
        _pollTimer.Start();

        _ = PollAsync();

        if (launchMode != TrayLaunchMode.Autostart)
        {
            // Interactive Start Menu launch or the installer's completion
            // launch (--open-web): the user asked to SEE the app, so
            // surface the web UI. Autostart (Run key at logon) stays a
            // silent icon — a browser popping up at every logon would be
            // hostile.
            _ = SurfaceWebUiAsync();
        }
    }

    private void OnOpenWebSignal(object? state) => _ = SurfaceWebUiAsync();

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

        // ServerControl.Decide only consults the SCM snapshot for states
        // the live listener cannot actually report (stopped/crashed), so
        // skip the SCM round-trip for the ones it can.
        var needsScm = serverState is not (ProcessStates.Running or ProcessStates.Starting or ProcessStates.Stopping);
        ApplyPlan(ServerControl.Decide(status, needsScm ? ServiceManagerProbe.Query() : null));

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
        // The rc "Start server is always grayed out" fix: unreachable no
        // longer hard-disables the item — the SCM snapshot decides, and a
        // stopped LoombreServer service yields an ENABLED Start.
        ApplyPlan(ServerControl.Decide(null, ServiceManagerProbe.Query()));
    }

    private void ApplyPlan(ServerControlPlan plan)
    {
        _lastPlan = plan;
        if (_shutdownInFlight)
        {
            // Mid-shutdown a poll may race the services' stop transitions
            // — don't let it re-enable lifecycle actions under the UAC
            // prompt / stop wait.
            _startStopItem.Enabled = false;
            return;
        }
        if (_scmStartInFlight)
        {
            // A start we issued is still settling — don't let a poll that
            // raced the SCM transition briefly re-enable the item.
            _startStopItem.Text = "Starting server…";
            _startStopItem.Enabled = false;
            return;
        }
        _startStopItem.Text = plan.Text;
        _startStopItem.Enabled = plan.Enabled;
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
            var url = await GetWebUrlAsync().ConfigureAwait(true);
            OpenBrowser(url);
        }
        catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
        {
            ShowWarning(ex);
        }
    }

    private async void OnStartStopClicked(object? sender, EventArgs e)
    {
        if (_shutdownInFlight)
        {
            return;
        }
        switch (_lastPlan?.Action)
        {
            case ServerLifecycleAction.StopViaIpc:
                await StopServerViaIpcAsync().ConfigureAwait(true);
                break;
            case ServerLifecycleAction.StartViaScm:
                await StartServerViaScmAsync().ConfigureAwait(true);
                break;
            default:
                break;
        }
    }

    private async Task StopServerViaIpcAsync()
    {
        try
        {
            var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
            using var client = new IpcClient(baseAddress, token);
            await client.StopServerAsync().ConfigureAwait(true);
            await PollAsync().ConfigureAwait(true);
        }
        catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
        {
            ShowWarning(ex);
        }
    }

    private async Task StartServerViaScmAsync()
    {
        if (_scmStartInFlight)
        {
            return;
        }
        _scmStartInFlight = true;
        _startStopItem.Text = "Starting server…";
        _startStopItem.Enabled = false;
        try
        {
            // ServiceController blocks on SCM round-trips — keep them off
            // the UI thread.
            await Task.Run(ServiceManagerProbe.StartServerStack).ConfigureAwait(true);
        }
        catch (Exception ex) when (ServiceManagerProbe.IsAccessDenied(ex))
        {
            // Services installed before Services.wxs granted Users the
            // start right — fall back to one UAC prompt.
            var accepted = await Task.Run(ServiceManagerProbe.TryStartServerStackElevated).ConfigureAwait(true);
            if (!accepted)
            {
                ShowBalloon("Starting the Loombre server needs administrator approval.", ToolTipIcon.Info);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            ShowBalloon($"Could not start the Loombre server: {ex.Message}", ToolTipIcon.Warning);
        }
        finally
        {
            _scmStartInFlight = false;
        }
        await PollAsync().ConfigureAwait(true);
    }

    /// <summary>The full kill switch — the mirror of the macOS menubar's
    /// "Shut Down Loombre…": confirmation dialog → ONE UAC prompt →
    /// `net stop` of all three services consumers-first/server-last
    /// (ServiceStack.StopOrder) → verify against the SCM → exit this
    /// tray too, so nothing of Loombre is left running. The services
    /// return at the next boot (Start=auto) or via Start Loombre; the
    /// tray returns at next logon (HKLM Run key) or from the Start
    /// Menu.</summary>
    private async void OnShutdownClicked(object? sender, EventArgs e)
    {
        if (_shutdownInFlight || _scmStartInFlight)
        {
            return;
        }
        var page = new TaskDialogPage
        {
            Caption = "Loombre",
            Heading = "Shut down Loombre completely?",
            Text = "This stops the Loombre server, the background worker, and the web interface — "
                + "streaming stops for every device using this server — and then closes this tray controller.\n\n"
                + "Windows will ask for administrator approval. To use Loombre again, open Loombre from the "
                + "Start Menu and choose “Start Loombre”, or restart this PC (the services start "
                + "automatically at boot).",
            Icon = TaskDialogIcon.Warning,
        };
        var shutDownButton = new TaskDialogButton("Shut Down");
        page.Buttons.Add(shutDownButton);
        page.Buttons.Add(TaskDialogButton.Cancel);
        if (TaskDialog.ShowDialog(page) != shutDownButton)
        {
            return;
        }

        _shutdownInFlight = true;
        _shutdownItem.Text = "Shutting down Loombre…";
        _shutdownItem.Enabled = false;
        _startStopItem.Enabled = false;
        try
        {
            // ServiceController/UAC round-trips block — keep them off the
            // UI thread (same rationale as StartServerViaScmAsync).
            var accepted = await Task.Run(ServiceManagerProbe.TryStopServerStackElevated).ConfigureAwait(true);
            if (!accepted)
            {
                ShowBalloon("Shutting down Loombre needs administrator approval.", ToolTipIcon.Info);
                ResetShutdownItem();
                return;
            }

            // TryStopServerStackElevated already waited for the elevated
            // `net stop` chain to exit; this loop only covers services
            // still draining a stop transition when it returned.
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
            while (DateTime.UtcNow < deadline)
            {
                var allStopped = await Task.Run(ServiceManagerProbe.AllStackServicesStopped).ConfigureAwait(true);
                if (allStopped)
                {
                    // Nothing left to control, and the point was
                    // "everything off" — exit the tray as well.
                    ExitThread();
                    return;
                }
                await Task.Delay(500).ConfigureAwait(true);
            }
            ShowBalloon(
                "Loombre's services did not all report stopped — check services.msc for their state.",
                ToolTipIcon.Warning);
            ResetShutdownItem();
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            ShowBalloon($"Could not shut down Loombre: {ex.Message}", ToolTipIcon.Warning);
            ResetShutdownItem();
        }
        await PollAsync().ConfigureAwait(true);
    }

    private void ResetShutdownItem()
    {
        _shutdownInFlight = false;
        _shutdownItem.Text = "Shut down Loombre…";
        _shutdownItem.Enabled = true;
    }

    /// <summary>The "user asked to see Loombre" flow — runs on the UI
    /// thread for every non-autostart launch, for the installer's
    /// completion launch, and whenever a second interactive launch
    /// signals this instance. Opens the browser as soon as the server
    /// answers with its web URL (on a fresh install that lands on the
    /// /setup wizard — the web root auto-routes there while no account
    /// exists); otherwise says what is actually going on instead of the
    /// rc field report's "nothing happens".</summary>
    private async Task SurfaceWebUiAsync()
    {
        if (_surfaceInFlight)
        {
            return;
        }
        _surfaceInFlight = true;
        try
        {
            var deadline = DateTime.UtcNow + SurfaceDeadline;
            var announcedStarting = false;
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    var url = await GetWebUrlAsync().ConfigureAwait(true);
                    OpenBrowser(url);
                    return;
                }
                catch (Exception ex) when (ex is IpcException or IOException or UnauthorizedAccessException or HttpRequestException)
                {
                    // Not reachable yet — fall through to the SCM check.
                }

                var scm = ServiceManagerProbe.Query();
                if (scm is null || !scm.ServiceExists)
                {
                    ShowBalloon(
                        "Loombre's server is not installed as a Windows service. Start it manually, then use \"Open Loombre\".",
                        ToolTipIcon.Warning);
                    return;
                }
                if (scm.State is ScmStates.Stopped or ScmStates.Paused)
                {
                    ShowBalloon(
                        "The Loombre server is stopped. Right-click the Loombre icon and choose \"Start Loombre\".",
                        ToolTipIcon.Info);
                    return;
                }
                if (!announcedStarting)
                {
                    announcedStarting = true;
                    ShowBalloon("Loombre is starting — your browser will open when it's ready.", ToolTipIcon.Info);
                }
                await Task.Delay(SurfaceRetryInterval).ConfigureAwait(true);
            }
            ShowBalloon(
                "Loombre did not become ready in time. Right-click the Loombre icon for status.",
                ToolTipIcon.Warning);
        }
        finally
        {
            _surfaceInFlight = false;
        }
    }

    private static async Task<string> GetWebUrlAsync()
    {
        var (baseAddress, token) = await Discovery.ReadAsync().ConfigureAwait(true);
        using var client = new IpcClient(baseAddress, token);
        var target = await client.GetOpenWebTargetAsync().ConfigureAwait(true);
        return target.Url;
    }

    private static void OpenBrowser(string url)
    {
        // The contract explicitly leaves launching a browser to the
        // controller (open-web-target.ts's header) — this is that step.
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
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

    private void ShowBalloon(string text, ToolTipIcon icon)
    {
        _icon.ShowBalloonTip(10_000, "Loombre", text, icon);
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
            _openWebWait?.Unregister(null);
            _pollTimer.Dispose();
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
