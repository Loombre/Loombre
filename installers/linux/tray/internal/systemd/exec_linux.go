// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/systemd/exec_linux.go
//
// The half of this package that actually runs systemctl. Linux-only by
// build tag so the decision data and parser above stay testable on any
// developer machine.
//
// NO sudo, NO pkexec. An unprivileged `systemctl start` from a desktop
// session is refused by systemd, which hands the request to polkit, which
// asks the session's authentication agent — the Linux analogue of the
// macOS menubar's AppleScript "with administrator privileges" prompt.
// Wrapping it in sudo instead would need a terminal that does not exist
// here; wrapping it in pkexec would run the whole systemctl as root rather
// than authorizing one action. Calling systemctl directly is the path the
// desktop already knows how to authorize.

//go:build linux

package systemd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
)

// Binary is the systemctl to run. Resolved through PATH, not hardcoded to
// /usr/bin or /bin: the two differ across the distributions this ships to.
const Binary = "systemctl"

// CommandError is a systemctl invocation that exited non-zero.
type CommandError struct {
	Args     []string
	ExitCode int
	Stderr   string
}

func (e *CommandError) Error() string {
	detail := Tail(e.Stderr, 0)
	if detail == "" {
		detail = fmt.Sprintf("exit status %d", e.ExitCode)
	}
	return fmt.Sprintf("systemctl %s: %s", e.Args[0], detail)
}

// IsAuthCancellation reports whether this failure was the user declining
// (or nothing answering) the polkit prompt.
func (e *CommandError) IsAuthCancellation() bool {
	return IsAuthCancellation(e.Stderr)
}

// Query asks systemd about the server unit. A nil error with
// UnitExists=false means systemd answered and there is no such unit; an
// error means systemd could not be asked at all (no systemctl on PATH, no
// D-Bus, a container without systemd).
func Query(ctx context.Context) (Snapshot, error) {
	stdout, err := run(ctx, ShowArgs(ServerUnit))
	if err != nil {
		return Snapshot{}, err
	}
	return ParseShow(stdout), nil
}

// Start starts the whole stack, server first. Blocks until systemctl
// exits — which, for the default synchronous mode, is after the jobs have
// been enqueued and settled, including however long the polkit prompt sat
// on screen. Callers bound it with the context.
func Start(ctx context.Context) error {
	_, err := run(ctx, StartArgs())
	return err
}

// Stop stops the whole stack, consumers first and the server last.
func Stop(ctx context.Context) error {
	_, err := run(ctx, StopArgs())
	return err
}

func run(ctx context.Context, args []string) (string, error) {
	cmd := exec.CommandContext(ctx, Binary, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		return stdout.String(), nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.String(), &CommandError{
			Args:     args,
			ExitCode: exitErr.ExitCode(),
			Stderr:   stderr.String(),
		}
	}
	// Not an exit status: systemctl is missing, or the context expired.
	return stdout.String(), fmt.Errorf("systemctl %s: %w", args[0], err)
}
