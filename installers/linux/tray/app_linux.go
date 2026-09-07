// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/app_linux.go
//
// All the Linux-specific plumbing: the StatusNotifierItem tray, the poll
// loop, and the four external programs this controller talks to
// (systemctl, xdg-open, notify-send, and the session bus). Nothing here
// decides anything — every judgement lives in internal/control,
// internal/systemd and internal/ipc, which is what makes those testable on
// a machine with no D-Bus at all.
//
// fyne.io/systray's Linux backend is pure Go: it exports a
// StatusNotifierItem and a com.canonical.dbusmenu over godbus and
// registers with org.kde.StatusNotifierWatcher. No cgo, no
// libappindicator, so the shipped binary is static and has no runtime
// library to go missing on any distribution.

//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/godbus/dbus/v5"

	"loombre.dev/linux-tray/internal/control"
	"loombre.dev/linux-tray/internal/ipc"
	"loombre.dev/linux-tray/internal/systemd"
)

const (
	// pollInterval matches the other two trays: fast enough that a stop
	// looks immediate, slow enough to be invisible in a process list.
	pollInterval   = 3 * time.Second
	requestTimeout = ipc.DefaultTimeout

	// systemctl start blocks while the polkit prompt is on screen and
	// while the units settle; a first start pays payload extraction,
	// initdb and migrations, which real hardware has taken minutes over.
	lifecycleTimeout = 180 * time.Second

	// stopSettleDelay gives the server time to act on its own SIGTERM
	// before the menu re-reads the world.
	stopSettleDelay = 750 * time.Millisecond

	// actionTimeout bounds the short IPC calls behind a menu click.
	actionTimeout = 10 * time.Second

	// openWebDeadline is how long --open-web waits for a first boot.
	openWebDeadline = 120 * time.Second
	openWebRetry    = 2 * time.Second

	// A tray host may register slightly after the session starts, so give
	// it a few tries before concluding there is nowhere to draw.
	trayHostDeadline = 10 * time.Second
	trayHostRetry    = 2 * time.Second

	watcherBusName   = "org.kde.StatusNotifierWatcher"
	notifySendBinary = "notify-send"
	openBinary       = "xdg-open"

	// Long enough to say what failed, short enough for a notification
	// popup to stay readable.
	stderrTailLimit = 200
)

// rendered caches what the menu currently shows, so a 3-second poll that
// changes nothing emits no D-Bus traffic at all.
type rendered struct {
	status           string
	lifecycle        string
	lifecycleEnabled bool
	shutdown         string
	shutdownEnabled  bool
	crashEnabled     bool
	version          string
	icon             control.Icon
}

type app struct {
	mode control.LaunchMode
	log  *log.Logger

	ctx    context.Context
	cancel context.CancelFunc

	statusItem    *systray.MenuItem
	openItem      *systray.MenuItem
	lifecycleItem *systray.MenuItem
	shutdownItem  *systray.MenuItem
	crashItem     *systray.MenuItem
	versionItem   *systray.MenuItem
	quitItem      *systray.MenuItem

	// mu guards everything the poll loop writes and the click handlers read.
	mu               sync.Mutex
	state            control.State
	plan             control.LifecyclePlan
	connected        bool
	serverVersion    string
	startInFlight    bool
	shutdownInFlight bool
	confirm          control.ShutdownConfirm
	notifiedNoAccess bool

	// renderMu serialises the menu mutations themselves; held separately
	// from mu so a slow D-Bus round trip never blocks a click handler
	// reading state.
	renderMu sync.Mutex
	shown    rendered
}

func runTray(mode control.LaunchMode) int {
	logger := log.New(os.Stderr, "loombre-tray: ", log.LstdFlags)

	lock, err := acquireInstanceLock()
	if err != nil {
		// A tray that refuses to start because a lock file misbehaved is
		// worse than a tray that briefly shows twice.
		logger.Printf("single-instance lock unavailable (%v) — starting anyway", err)
	} else if lock == nil {
		return runSecondInstance(mode, logger)
	}
	defer lock.release()

	ctx, cancel := context.WithCancel(context.Background())
	a := &app{mode: mode, log: logger, ctx: ctx, cancel: cancel}
	logger.Printf("starting %s (mode %s)", buildVersion, mode)
	systray.Run(a.onReady, a.onExit)
	return 0
}

// runSecondInstance handles a launch that lost the race for the lock. The
// running tray is never told anything: there is no IPC between instances
// and nothing it would do differently. Instead this process does the one
// thing the launch was actually asking for and exits.
func runSecondInstance(mode control.LaunchMode, logger *log.Logger) int {
	if mode == control.ModeAutostart {
		// Login autostart racing an already-running tray. Nothing to do,
		// and nothing worth saying about it.
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), openWebDeadline+30*time.Second)
	defer cancel()

	logger.Printf("another tray already holds %s — surfacing the web interface instead", lockPath())
	var url string
	if mode == control.ModeOpenWeb {
		url = waitForWebURL(ctx, logger, openWebDeadline)
	} else {
		url = currentWebURL(ctx, logger)
	}
	openURL(logger, url)
	return 0
}

func (a *app) onReady() {
	initial := control.Unreachable()
	initialLabel := initial.StatusLabel()
	initialVersion := control.VersionLine(buildVersion, initial, "")

	systray.SetIcon(iconBytes(initial.Icon()))
	systray.SetTooltip(initialLabel)

	// Menu order mirrors the macOS menubar and the Windows tray so the
	// three read the same on a support call.
	a.statusItem = systray.AddMenuItem(initialLabel, initialLabel)
	a.statusItem.Disable()
	systray.AddSeparator()

	a.openItem = systray.AddMenuItem("Open Loombre", "Open the Loombre web interface")
	a.lifecycleItem = systray.AddMenuItem(control.TitleStart, "Start or stop the Loombre server")
	a.lifecycleItem.Disable()
	a.shutdownItem = systray.AddMenuItem(control.TitleShutdown, "Stop every Loombre service and quit this tray")
	systray.AddSeparator()

	a.crashItem = systray.AddMenuItem("Reveal crash files", "Open the folder holding Loombre's crash logs")
	a.crashItem.Disable()
	systray.AddSeparator()

	a.versionItem = systray.AddMenuItem(initialVersion, "")
	a.versionItem.Disable()
	systray.AddSeparator()

	a.quitItem = systray.AddMenuItem("Quit", "Quit this tray; Loombre keeps running")

	// Seed the render cache with what was just built, so the first poll
	// only touches what actually differs.
	a.shown = rendered{
		status:    initialLabel,
		lifecycle: control.TitleStart,
		shutdown:  control.TitleShutdown,
		// AddMenuItem creates enabled items; the two Disable() calls above
		// are the only departures.
		shutdownEnabled: true,
		version:         initialVersion,
		icon:            initial.Icon(),
	}

	go a.onClick(a.openItem, a.onOpen)
	go a.onClick(a.lifecycleItem, a.onLifecycle)
	go a.onClick(a.shutdownItem, a.onShutdown)
	go a.onClick(a.crashItem, a.onRevealCrash)
	go a.onClick(a.quitItem, func() { systray.Quit() })

	go a.pollLoop()
	go a.checkTrayHost()

	if a.mode == control.ModeOpenWeb {
		go a.openWebOnBoot()
	}
}

func (a *app) onExit() {
	a.cancel()
	a.log.Printf("tray exiting")
}

// onClick runs one item's handler serially: a second click on the same
// item waits for the first to finish, while every other item stays live
// (Quit must never queue behind a slow shutdown).
func (a *app) onClick(item *systray.MenuItem, handler func()) {
	for range item.ClickedCh {
		handler()
	}
}

// ---------------------------------------------------------------- polling

func (a *app) pollLoop() {
	a.pollOnce()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.pollOnce()
		}
	}
}

func (a *app) pollOnce() {
	ctx, cancel := context.WithTimeout(a.ctx, requestTimeout+time.Second)
	defer cancel()

	discovery := ipc.Resolve(ipc.Options{})
	switch discovery.Availability {
	case ipc.AvailabilityReady:
		client := ipc.NewClientFor(discovery, requestTimeout)
		status, err := client.Status(ctx)
		if err != nil {
			// The files are fine but nothing answered: the server is
			// mid-boot, or it died without cleaning up. Same UI as "not
			// running" — there is nothing more specific to say — but
			// logged, because it is a different fact about the world.
			a.log.Printf("status request to %s failed: %v", discovery.BaseURL, err)
			a.applyDisconnected(ctx, control.Unreachable())
			return
		}
		a.apply(
			control.Derive(status),
			control.DecideLifecycle(status, a.systemdSnapshotFor(ctx, status)),
			true,
			status.Server.Version,
		)
	case ipc.AvailabilityNoAccess:
		a.applyNoAccess(ctx, discovery)
	case ipc.AvailabilityNotFound:
		a.applyDisconnected(ctx, control.Unreachable())
	default:
		a.log.Printf("discovery in %s is %s: %v", discovery.Dir, discovery.Availability, discovery.Err)
		a.applyDisconnected(ctx, control.Unreachable())
	}
}

// systemdSnapshotFor skips the systemctl round trip for the states the
// live listener can already answer for — otherwise every 3-second tick
// would fork a process for an answer it is not going to use.
func (a *app) systemdSnapshotFor(ctx context.Context, status *ipc.StatusResponse) *systemd.Snapshot {
	switch status.Server.State {
	case ipc.ProcessRunning, ipc.ProcessStarting, ipc.ProcessStopping:
		return nil
	}
	return a.querySystemd(ctx)
}

func (a *app) querySystemd(ctx context.Context) *systemd.Snapshot {
	snapshot, err := systemd.Query(ctx)
	if err != nil {
		// No systemctl, no systemd, or no permission to ask. A nil
		// snapshot disables Start rather than offering one that cannot work.
		a.log.Printf("systemctl show failed: %v", err)
		return nil
	}
	return &snapshot
}

func (a *app) applyDisconnected(ctx context.Context, state control.State) {
	a.apply(state, control.DecideLifecycle(nil, a.querySystemd(ctx)), false, "")
}

// applyNoAccess handles the Linux-only failure the other two platforms do
// not have: the server is up, the files are there, and this user is not in
// the group allowed to read the token. Notified ONCE per run — the poll
// repeats every 3 seconds, and a notification storm helps nobody.
func (a *app) applyNoAccess(ctx context.Context, discovery ipc.Discovery) {
	var group, command string
	if discovery.Access != nil {
		group = discovery.Access.Group
		command = discovery.Access.UsermodCommand()
	}

	a.mu.Lock()
	first := !a.notifiedNoAccess
	a.notifiedNoAccess = true
	a.mu.Unlock()

	if first {
		a.log.Printf("cannot read the IPC token in %s (%v) — fix with: %s", discovery.Dir, discovery.Err, command)
		title, body := control.NoAccessNotification(command)
		a.notify(title, body)
	}
	a.applyDisconnected(ctx, control.NoAccess(group))
}

func (a *app) apply(state control.State, plan control.LifecyclePlan, connected bool, serverVersion string) {
	a.mu.Lock()
	a.state = state
	a.plan = plan
	a.connected = connected
	a.serverVersion = serverVersion
	a.mu.Unlock()
	a.render()
}

// --------------------------------------------------------------- rendering

func (a *app) render() {
	a.mu.Lock()
	state := a.state
	plan := a.plan
	connected := a.connected
	serverVersion := a.serverVersion
	startInFlight := a.startInFlight
	shutdownInFlight := a.shutdownInFlight
	shutdownTitle := a.confirm.Title(time.Now(), shutdownInFlight)
	a.mu.Unlock()

	a.renderMu.Lock()
	defer a.renderMu.Unlock()

	if label := state.StatusLabel(); label != a.shown.status {
		a.statusItem.SetTitle(label)
		a.statusItem.SetTooltip(label)
		systray.SetTooltip(label)
		a.shown.status = label
	}
	if icon := state.Icon(); icon != a.shown.icon {
		systray.SetIcon(iconBytes(icon))
		a.shown.icon = icon
	}

	lifecycleTitle, lifecycleEnabled := plan.Title, plan.Enabled
	switch {
	case startInFlight:
		// A start we issued is still settling — don't let a poll that
		// raced the systemd transition briefly re-enable the item.
		lifecycleTitle, lifecycleEnabled = control.TitleStarting, false
	case shutdownInFlight:
		lifecycleEnabled = false
	}
	setItem(a.lifecycleItem, &a.shown.lifecycle, &a.shown.lifecycleEnabled, lifecycleTitle, lifecycleEnabled)

	// A kill switch must never depend on the thing it kills: shut-down
	// stays enabled regardless of IPC reachability and systemd state. The
	// services may well be up while IPC is broken, which is exactly when
	// someone most needs a way to stop everything. It is disabled only
	// while another lifecycle operation is already in flight.
	setItem(a.shutdownItem, &a.shown.shutdown, &a.shown.shutdownEnabled,
		shutdownTitle, !shutdownInFlight && !startInFlight)

	if connected != a.shown.crashEnabled {
		if connected {
			a.crashItem.Enable()
		} else {
			a.crashItem.Disable()
		}
		a.shown.crashEnabled = connected
	}

	if line := control.VersionLine(buildVersion, state, serverVersion); line != a.shown.version {
		a.versionItem.SetTitle(line)
		a.shown.version = line
	}
}

func setItem(item *systray.MenuItem, shownTitle *string, shownEnabled *bool, title string, enabled bool) {
	if title != *shownTitle {
		item.SetTitle(title)
		*shownTitle = title
	}
	if enabled != *shownEnabled {
		if enabled {
			item.Enable()
		} else {
			item.Disable()
		}
		*shownEnabled = enabled
	}
}

// ---------------------------------------------------------------- actions

func (a *app) onOpen() {
	ctx, cancel := context.WithTimeout(a.ctx, actionTimeout)
	defer cancel()
	a.openURL(currentWebURL(ctx, a.log))
}

func (a *app) onLifecycle() {
	a.mu.Lock()
	plan := a.plan
	busy := a.startInFlight || a.shutdownInFlight
	a.mu.Unlock()
	if busy {
		return
	}
	switch plan.Action {
	case control.ActionStopViaIPC:
		a.stopViaIPC()
	case control.ActionStartViaSystemd:
		a.startViaSystemd()
	}
}

func (a *app) stopViaIPC() {
	ctx, cancel := context.WithTimeout(a.ctx, actionTimeout)
	defer cancel()

	discovery := ipc.Resolve(ipc.Options{})
	if discovery.Availability != ipc.AvailabilityReady {
		a.log.Printf("stop requested but discovery is %s: %v", discovery.Availability, discovery.Err)
		a.notify("Could not stop Loombre", "The Loombre server is no longer reachable.")
		a.pollOnce()
		return
	}
	if _, err := ipc.NewClientFor(discovery, requestTimeout).StopServer(ctx); err != nil {
		a.log.Printf("stop failed: %v", err)
		a.notify("Could not stop Loombre", err.Error())
		return
	}
	// The server flushes the 200 and then SIGTERMs itself; re-poll soon so
	// the menu follows it down instead of waiting out the next tick.
	select {
	case <-a.ctx.Done():
		return
	case <-time.After(stopSettleDelay):
	}
	a.pollOnce()
}

// startViaSystemd starts the whole stack. No sudo and no pkexec: an
// unprivileged systemctl call from a desktop session is routed to polkit,
// which raises the session's own authentication prompt — the Linux
// equivalent of the UAC dialog the Windows tray gets and the
// "administrator privileges" prompt the macOS menubar gets.
func (a *app) startViaSystemd() {
	a.mu.Lock()
	if a.startInFlight {
		a.mu.Unlock()
		return
	}
	a.startInFlight = true
	a.mu.Unlock()
	a.render()

	ctx, cancel := context.WithTimeout(context.Background(), lifecycleTimeout)
	defer cancel()
	err := systemd.Start(ctx)

	a.mu.Lock()
	a.startInFlight = false
	a.mu.Unlock()

	if err != nil {
		a.reportSystemctlFailure("start", err, systemd.ManualStartCommand())
	}
	a.pollOnce()
}

// onShutdown is the full kill switch, and the one place this tray departs
// from its siblings' UX: there is no toolkit here to open a confirmation
// dialog with, so the menu item confirms itself (internal/control/confirm.go).
func (a *app) onShutdown() {
	a.mu.Lock()
	if a.shutdownInFlight || a.startInFlight {
		a.mu.Unlock()
		return
	}
	if a.confirm.Click(time.Now()) == control.ConfirmArmed {
		a.mu.Unlock()
		a.render()
		// Re-render once the window lapses, so an unconfirmed item goes
		// back to reading like the thing it is.
		go func() {
			select {
			case <-a.ctx.Done():
			case <-time.After(control.ConfirmWindow + 250*time.Millisecond):
				a.render()
			}
		}()
		return
	}
	a.shutdownInFlight = true
	a.mu.Unlock()
	a.render()

	// Not a.ctx: this operation outlives the tray on the success path.
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleTimeout)
	defer cancel()

	if err := systemd.Stop(ctx); err != nil {
		a.mu.Lock()
		a.shutdownInFlight = false
		a.mu.Unlock()
		a.reportSystemctlFailure("shut down", err, systemd.ManualStopCommand())
		a.pollOnce()
		return
	}

	// Nothing left to control, and the point was "everything off" — so the
	// tray goes too. The enabled units bring the stack back at the next
	// boot; "Start Loombre" from a relaunched tray brings it back sooner.
	a.log.Printf("Loombre services stopped; quitting the tray")
	systray.Quit()
}

func (a *app) onRevealCrash() {
	ctx, cancel := context.WithTimeout(a.ctx, actionTimeout)
	defer cancel()

	discovery := ipc.Resolve(ipc.Options{})
	if discovery.Availability != ipc.AvailabilityReady {
		a.notify("Crash files unavailable", "Loombre is not reachable, so its crash files cannot be listed.")
		return
	}
	response, err := ipc.NewClientFor(discovery, requestTimeout).CrashFiles(ctx)
	if err != nil {
		a.log.Printf("crash-files request failed: %v", err)
		a.notify("Crash files unavailable", err.Error())
		return
	}

	plan := control.PlanCrashReveal(response.Files)
	if plan.Kind == control.CrashNoneFound {
		// The healthy steady state, not an error: the crashes directory is
		// created lazily on the first crash.
		a.notify("No crash files found", "Loombre has not written any crash logs.")
		return
	}
	// The DIRECTORY, not the file: Linux has no portable equivalent of
	// `explorer /select` or Finder's activateFileViewerSelecting. And only
	// when this user can actually open it: the packages install the data
	// directory 0750 owned by the service account, so for a desktop user
	// the folder is unreachable (the file manager reports it as missing).
	// Then the web Dashboard's crash card — the same files, through the
	// authenticated API — is what gets opened, with the path in the
	// notification for anyone who wants to `sudo ls` it.
	if dir, err := os.Open(plan.Directory); err == nil {
		_ = dir.Close()
		a.notify("Loombre crash files", fmt.Sprintf("%d file(s) in %s\nNewest: %s", plan.Count, plan.Directory, plan.NewestPath))
		a.openURL(plan.Directory)
		return
	}
	a.notify("Loombre crash files",
		fmt.Sprintf("%d file(s) in %s (owned by the service account — opening the Dashboard's crash card instead)\nNewest: %s", plan.Count, plan.Directory, plan.NewestPath))
	a.openURL(control.AdminCrashPageURL(currentWebURL(ctx, a.log)))
}

func (a *app) reportSystemctlFailure(verb string, err error, manualCommand string) {
	var cmdErr *systemd.CommandError
	isCommandError := errors.As(err, &cmdErr)

	if isCommandError && cmdErr.IsAuthCancellation() {
		// Declining an authentication prompt is a decision, not a failure.
		a.log.Printf("systemctl %s was not authorized: %s", verb, systemd.Tail(cmdErr.Stderr, stderrTailLimit))
		a.notify("Loombre needs authorization",
			fmt.Sprintf("The %s was cancelled at the authentication prompt. From a terminal:\n%s", verb, manualCommand))
		return
	}

	detail := err.Error()
	if isCommandError {
		if tail := systemd.Tail(cmdErr.Stderr, stderrTailLimit); tail != "" {
			detail = tail
		}
	}
	a.log.Printf("systemctl %s failed: %v", verb, err)
	a.notify(fmt.Sprintf("Could not %s Loombre", verb),
		fmt.Sprintf("%s\n\nFrom a terminal:\n%s", detail, manualCommand))
}

// ------------------------------------------------------------- web opening

// currentWebURL asks a reachable server where its web UI actually is. With
// no connection there is no way to learn an operator's configured URL, so
// it falls back to the one the packages install — the same single fallback
// the macOS menubar uses, for the same reason.
func currentWebURL(ctx context.Context, logger *log.Logger) string {
	discovery := ipc.Resolve(ipc.Options{})
	if discovery.Availability == ipc.AvailabilityReady {
		target, err := ipc.NewClientFor(discovery, requestTimeout).OpenWebTarget(ctx)
		if err == nil && target.URL != "" {
			return target.URL
		}
		if err != nil {
			logger.Printf("open-web-target unavailable (%v) — falling back to %s", err, control.InstalledDefaultWebURL)
		}
	}
	return control.InstalledDefaultWebURL
}

// waitForWebURL is the --open-web flow: a first install pays payload
// extraction, initdb and migrations before anything serves HTTP, so the
// completion launch waits it out rather than opening a browser at a port
// nothing is listening on yet.
func waitForWebURL(ctx context.Context, logger *log.Logger, wait time.Duration) string {
	deadline := time.Now().Add(wait)
	announced := false
	for {
		discovery := ipc.Resolve(ipc.Options{})
		if discovery.Availability == ipc.AvailabilityReady {
			status, err := ipc.NewClientFor(discovery, requestTimeout).Status(ctx)
			if err == nil && status.WebURL != nil && *status.WebURL != "" {
				return *status.WebURL
			}
		}
		if !announced {
			announced = true
			logger.Printf("waiting up to %s for Loombre to report a web URL", wait)
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			logger.Printf("no web URL after %s — opening %s", wait, control.InstalledDefaultWebURL)
			return control.InstalledDefaultWebURL
		}
		select {
		case <-ctx.Done():
			return control.InstalledDefaultWebURL
		case <-time.After(openWebRetry):
		}
	}
}

func (a *app) openWebOnBoot() {
	ctx, cancel := context.WithTimeout(a.ctx, openWebDeadline+30*time.Second)
	defer cancel()
	a.openURL(waitForWebURL(ctx, a.log, openWebDeadline))
}

func (a *app) openURL(target string) { openURL(a.log, target) }

// openURL hands a URL or a directory to the desktop's own handler. The
// contract deliberately leaves opening a browser to the controller
// (open-web-target.ts's header) — this is that step.
func openURL(logger *log.Logger, target string) {
	cmd := exec.Command(openBinary, target)
	if err := cmd.Start(); err != nil {
		logger.Printf("%s %s failed: %v", openBinary, target, err)
		notify(logger, "Could not open Loombre",
			fmt.Sprintf("%s failed (%v). Open %s yourself.", openBinary, err, target))
		return
	}
	// Detached, but reaped: xdg-open exits as soon as the desktop has taken
	// the request, and an unwaited child would sit as a zombie for the life
	// of the tray.
	go func() { _ = cmd.Wait() }()
}

// ------------------------------------------------------- desktop integration

func (a *app) notify(title, body string) { notify(a.log, title, body) }

func notify(logger *log.Logger, title, body string) {
	path, err := exec.LookPath(notifySendBinary)
	if err != nil {
		// No notification tooling installed: stderr is the fallback
		// surface. Never silence.
		logger.Printf("%s: %s", title, strings.ReplaceAll(body, "\n", " "))
		return
	}
	cmd := exec.Command(path, "--app-name=Loombre", "--icon=loombre", title, body)
	if err := cmd.Start(); err != nil {
		logger.Printf("%s failed (%v) — %s: %s", notifySendBinary, err, title, strings.ReplaceAll(body, "\n", " "))
		return
	}
	go func() { _ = cmd.Wait() }()
}

// checkTrayHost covers the single most common "the tray does nothing"
// report on Linux: stock GNOME ships no StatusNotifierItem host, so the
// item registers into the void. The process is fine and there is nothing
// to fix in it — the user needs to install an extension — so this says so
// once and keeps running. fyne.io/systray watches for a watcher appearing
// and re-registers itself, which means the icon shows up the moment one
// does, without restarting anything.
func (a *app) checkTrayHost() {
	deadline := time.Now().Add(trayHostDeadline)
	for {
		if hasTrayHost(a.log) {
			return
		}
		if !time.Now().Before(deadline) {
			break
		}
		select {
		case <-a.ctx.Done():
			return
		case <-time.After(trayHostRetry):
		}
	}
	a.log.Printf("no %s on the session bus — the tray icon has nowhere to draw", watcherBusName)
	title, body := control.NoTrayHostNotification()
	a.notify(title, body)
}

func hasTrayHost(logger *log.Logger) bool {
	// Never Close() this: dbus.SessionBus() hands back the shared session
	// connection systray itself exported its item on.
	conn, err := dbus.SessionBus()
	if err != nil {
		logger.Printf("session bus unavailable: %v", err)
		return false
	}
	var owned bool
	call := conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, watcherBusName)
	if err := call.Store(&owned); err != nil {
		logger.Printf("NameHasOwner(%s) failed: %v", watcherBusName, err)
		return false
	}
	return owned
}
