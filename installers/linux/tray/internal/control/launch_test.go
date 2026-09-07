// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/launch_test.go

package control

import (
	"strings"
	"testing"
)

func TestParseLaunch(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want LaunchMode
	}{
		{name: "no flags is interactive", args: nil, want: ModeInteractive},
		{name: "empty slice is interactive", args: []string{}, want: ModeInteractive},
		{name: "autostart", args: []string{"--autostart"}, want: ModeAutostart},
		{name: "open-web", args: []string{"--open-web"}, want: ModeOpenWeb},
		{
			name: "open-web wins over autostart",
			args: []string{"--autostart", "--open-web"},
			want: ModeOpenWeb,
		},
		{
			name: "order does not matter",
			args: []string{"--open-web", "--autostart"},
			want: ModeOpenWeb,
		},
		{
			// An older binary launched by a newer package's desktop file
			// must degrade to a normal launch, not fail at login.
			name: "unknown flags are ignored",
			args: []string{"--future-flag", "--autostart", "positional"},
			want: ModeAutostart,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseLaunch(tc.args)
			if got.Mode != tc.want {
				t.Fatalf("Mode = %v, want %v", got.Mode, tc.want)
			}
			if got.ShowHelp || got.ShowVersion {
				t.Fatalf("unexpected help/version request: %+v", got)
			}
		})
	}
}

func TestParseLaunchVersionAndHelp(t *testing.T) {
	if !ParseLaunch([]string{"--version"}).ShowVersion {
		t.Error("--version not recognised")
	}
	if !ParseLaunch([]string{"-v"}).ShowVersion {
		t.Error("-v not recognised")
	}
	if !ParseLaunch([]string{"--help"}).ShowHelp {
		t.Error("--help not recognised")
	}
	if !ParseLaunch([]string{"-h"}).ShowHelp {
		t.Error("-h not recognised")
	}
}

// Flags are case-sensitive on purpose (Linux convention); the desktop
// files in this repo author them exactly.
func TestParseLaunchIsCaseSensitive(t *testing.T) {
	if ParseLaunch([]string{"--AutoStart"}).Mode != ModeInteractive {
		t.Fatal("flag matching should be case-sensitive")
	}
}

func TestLaunchModeStrings(t *testing.T) {
	for mode, want := range map[LaunchMode]string{
		ModeInteractive: "interactive",
		ModeAutostart:   "autostart",
		ModeOpenWeb:     "open-web",
	} {
		if mode.String() != want {
			t.Errorf("LaunchMode(%d).String() = %q, want %q", int(mode), mode.String(), want)
		}
	}
}

func TestUsageTextDocumentsEveryFlag(t *testing.T) {
	for _, flag := range []string{FlagAutostart, FlagOpenWeb, FlagVersion, FlagHelp, "LOOMBRE_IPC_DIR"} {
		if !strings.Contains(UsageText, flag) {
			t.Errorf("--help does not mention %q", flag)
		}
	}
}
