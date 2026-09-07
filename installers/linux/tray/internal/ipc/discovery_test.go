// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/discovery_test.go

package ipc

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeFile is the minimum fs.FileInfo a stat seam needs to return.
type fakeFile struct{ name string }

func (f fakeFile) Name() string       { return f.name }
func (f fakeFile) Size() int64        { return 0 }
func (f fakeFile) Mode() fs.FileMode  { return 0o640 }
func (f fakeFile) ModTime() time.Time { return time.Time{} }
func (f fakeFile) IsDir() bool        { return false }
func (f fakeFile) Sys() any           { return nil }

func discoveryJSON(t *testing.T, port, pid int, host string) []byte {
	t.Helper()
	raw, err := json.Marshal(DiscoveryFile{Port: port, Host: host, PID: pid, StartedAtMs: 1732400000000})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func TestDefaultDirsOrder(t *testing.T) {
	custom := DefaultDirs(func(key string) string {
		if key == "LOOMBRE_IPC_DIR" {
			return "  /srv/loombre/ipc "
		}
		return ""
	})
	if len(custom) != 2 || custom[0] != "/srv/loombre/ipc" || custom[1] != "/run/loombre" {
		t.Fatalf("with LOOMBRE_IPC_DIR: %v", custom)
	}
	plain := DefaultDirs(func(string) string { return "" })
	if len(plain) != 1 || plain[0] != "/run/loombre" {
		t.Fatalf("without LOOMBRE_IPC_DIR: %v", plain)
	}
	if DataDirFallback != "/var/lib/loombre" {
		t.Fatalf("DataDirFallback = %q", DataDirFallback)
	}
	nilEnv := DefaultDirs(nil)
	if len(nilEnv) != 1 {
		t.Fatalf("nil getenv: %v", nilEnv)
	}
}

func TestResolveNotFound(t *testing.T) {
	got := Resolve(Options{
		Dirs:     []string{"/run/loombre", "/var/lib/loombre"},
		ReadFile: func(string) ([]byte, error) { return nil, fs.ErrNotExist },
	})
	if got.Availability != AvailabilityNotFound {
		t.Fatalf("Availability = %v, want not-found", got.Availability)
	}
}

// The first directory that HAS a discovery file wins, even when a later
// candidate would also work.
func TestResolveTakesTheFirstDirectoryThatHasTheFile(t *testing.T) {
	got := Resolve(Options{
		Dirs: []string{"/first", "/second"},
		Live: func(int) bool { return true },
		ReadFile: func(name string) ([]byte, error) {
			switch name {
			case filepath.Join("/first", DiscoveryFilename):
				return nil, fs.ErrNotExist
			case filepath.Join("/second", DiscoveryFilename):
				return discoveryJSON(t, 54217, 4242, LoopbackHost), nil
			case filepath.Join("/second", TokenFilename):
				return []byte("deadbeef\n"), nil
			}
			return nil, fs.ErrNotExist
		},
	})
	if got.Availability != AvailabilityReady {
		t.Fatalf("Availability = %v (%v)", got.Availability, got.Err)
	}
	if got.Dir != "/second" {
		t.Fatalf("Dir = %q", got.Dir)
	}
	if got.BaseURL != "http://127.0.0.1:54217" {
		t.Fatalf("BaseURL = %q", got.BaseURL)
	}
	if got.Token != "deadbeef" {
		t.Fatalf("Token = %q — surrounding whitespace must be trimmed", got.Token)
	}
}

// (b) discovery file present but its pid is dead.
func TestResolveStalePid(t *testing.T) {
	got := Resolve(Options{
		Dirs: []string{"/run/loombre"},
		Live: func(pid int) bool {
			if pid != 4242 {
				t.Fatalf("liveness asked about pid %d", pid)
			}
			return false
		},
		ReadFile: func(name string) ([]byte, error) {
			if name == filepath.Join("/run/loombre", DiscoveryFilename) {
				return discoveryJSON(t, 54217, 4242, LoopbackHost), nil
			}
			t.Fatalf("token must not be read once the pid is known dead (read %q)", name)
			return nil, nil
		},
	})
	if got.Availability != AvailabilityStale {
		t.Fatalf("Availability = %v", got.Availability)
	}
	if got.File.PID != 4242 {
		t.Fatalf("stale result should carry the file it rejected: %+v", got.File)
	}
}

// (c) discovery readable, token not — the Linux-only state, and the one
// with an actionable fix.
func TestResolveTokenPermissionDeniedYieldsUsermodHint(t *testing.T) {
	tokenPath := filepath.Join("/run/loombre", TokenFilename)
	got := Resolve(Options{
		Dirs: []string{"/run/loombre"},
		Live: func(int) bool { return true },
		ReadFile: func(name string) ([]byte, error) {
			if name == tokenPath {
				return nil, fs.ErrPermission
			}
			return discoveryJSON(t, 54217, 4242, LoopbackHost), nil
		},
		Stat: func(name string) (fs.FileInfo, error) {
			if name != tokenPath {
				t.Fatalf("hint should stat the token file, got %q", name)
			}
			return fakeFile{name: TokenFilename}, nil
		},
		LookupGroup: func(string) (string, error) { return "loombre", nil },
		Username:    func() string { return "ada" },
	})
	if got.Availability != AvailabilityNoAccess {
		t.Fatalf("Availability = %v (%v)", got.Availability, got.Err)
	}
	if got.Access == nil {
		t.Fatal("no-access result must carry an Access hint")
	}
	// fakeFile.Sys() returns nil, so the gid never resolves — the hint
	// degrades to a placeholder group rather than losing the command.
	if got.Access.Username != "ada" {
		t.Fatalf("Access.Username = %q", got.Access.Username)
	}
	if got.Access.UsermodCommand() != "sudo usermod -aG <group> ada" {
		t.Fatalf("UsermodCommand = %q", got.Access.UsermodCommand())
	}
}

func TestUsermodCommandUsesResolvedGroup(t *testing.T) {
	access := Access{Path: "/run/loombre/controller-ipc.token", Group: "wheel", Username: "ada"}
	if got := access.UsermodCommand(); got != "sudo usermod -aG wheel ada" {
		t.Fatalf("UsermodCommand = %q", got)
	}
}

func TestUsermodCommandFallsBackWhenNothingResolved(t *testing.T) {
	if got := (Access{}).UsermodCommand(); got != "sudo usermod -aG <group> $USER" {
		t.Fatalf("UsermodCommand = %q", got)
	}
}

// The 0750 directory case: nothing inside can even be stat'd, so the hint
// comes off the directory itself.
func TestResolveDirectoryPermissionDenied(t *testing.T) {
	got := Resolve(Options{
		Dirs:     []string{"/run/loombre"},
		ReadFile: func(string) ([]byte, error) { return nil, fs.ErrPermission },
		Stat: func(name string) (fs.FileInfo, error) {
			if name == "/run/loombre" {
				return fakeFile{name: "loombre"}, nil
			}
			return nil, fs.ErrPermission
		},
		LookupGroup: func(string) (string, error) { return "", os.ErrNotExist },
		Username:    func() string { return "ada" },
	})
	if got.Availability != AvailabilityNoAccess {
		t.Fatalf("Availability = %v", got.Availability)
	}
	if got.Access == nil || got.Access.Path != "/run/loombre" {
		t.Fatalf("hint should point at the unreadable directory: %+v", got.Access)
	}
}

// The /run/loombre case the packages actually produce: a 0755 directory
// whose discovery file is 0640 owned by the admin group. The file can be
// stat'd but not read, and the hint must name the FILE's group — the
// directory belongs to the service account, and naming that group would
// send the user to join the wrong one.
func TestResolveDiscoveryFilePermissionDeniedHintsOffTheFile(t *testing.T) {
	discoveryPath := filepath.Join("/run/loombre", DiscoveryFilename)
	var statted []string
	got := Resolve(Options{
		Dirs:     []string{"/run/loombre"},
		ReadFile: func(string) ([]byte, error) { return nil, fs.ErrPermission },
		Stat: func(name string) (fs.FileInfo, error) {
			statted = append(statted, name)
			return fakeFile{name: filepath.Base(name)}, nil
		},
		LookupGroup: func(string) (string, error) { return "wheel", nil },
		Username:    func() string { return "ada" },
	})
	if got.Availability != AvailabilityNoAccess {
		t.Fatalf("Availability = %v", got.Availability)
	}
	if got.Access == nil || got.Access.Path != discoveryPath {
		t.Fatalf("hint should point at the unreadable discovery file: %+v", got.Access)
	}
	if len(statted) == 0 || statted[0] != discoveryPath {
		t.Fatalf("the file must be stat'd before the directory: %v", statted)
	}
}

func TestResolveMalformedCases(t *testing.T) {
	cases := []struct {
		name      string
		discovery []byte
		token     []byte
	}{
		{name: "torn json", discovery: []byte(`{"port":542`), token: []byte("token")},
		{name: "foreign host", discovery: discoveryJSON(t, 54217, 4242, "0.0.0.0"), token: []byte("token")},
		{name: "port out of range", discovery: discoveryJSON(t, 0, 4242, LoopbackHost), token: []byte("token")},
		{name: "empty token", discovery: discoveryJSON(t, 54217, 4242, LoopbackHost), token: []byte("   \n")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Resolve(Options{
				Dirs: []string{"/run/loombre"},
				Live: func(int) bool { return true },
				ReadFile: func(name string) ([]byte, error) {
					if name == filepath.Join("/run/loombre", TokenFilename) {
						return tc.token, nil
					}
					return tc.discovery, nil
				},
			})
			if got.Availability != AvailabilityMalformed {
				t.Fatalf("Availability = %v (%v)", got.Availability, got.Err)
			}
			if got.Err == nil {
				t.Fatal("malformed results must carry a cause for the log line")
			}
		})
	}
}

// The liveness probe and the group lookup are POSIX (platform_unix.go;
// platform_other.go stubs them out), and the fallback fakes below match
// on "/"-joined paths — none of it is meaningful on a Windows host, where
// the package only has to compile.
func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process/path semantics — the tray never runs on Windows")
	}
}

// End-to-end against a real temp directory, with only the liveness check
// faked — proves the default seams (os.ReadFile, path joining) are wired
// the way the injected tests assume.
func TestResolveAgainstRealFiles(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, DiscoveryFilename), discoveryJSON(t, 45001, os.Getpid(), LoopbackHost), 0o644); err != nil {
		t.Fatalf("write discovery: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, TokenFilename), []byte("0123456789abcdef\n"), 0o640); err != nil {
		t.Fatalf("write token: %v", err)
	}

	got := Resolve(Options{Dirs: []string{filepath.Join(dir, "missing"), dir}})
	if got.Availability != AvailabilityReady {
		t.Fatalf("Availability = %v (%v)", got.Availability, got.Err)
	}
	if got.BaseURL != "http://127.0.0.1:45001" {
		t.Fatalf("BaseURL = %q", got.BaseURL)
	}
	if got.Token != "0123456789abcdef" {
		t.Fatalf("Token = %q", got.Token)
	}
}

// The real liveness probe: this test's own pid is alive by construction,
// and a pid of 0 or a negative one never is.
func TestProcessAliveOnThisProcess(t *testing.T) {
	skipOnWindows(t)
	if !processAlive(os.Getpid()) {
		t.Fatal("this test's own process should read as alive")
	}
	if processAlive(0) || processAlive(-1) {
		t.Fatal("pid 0 and negative pids must never read as alive")
	}
}

func TestAvailabilityStrings(t *testing.T) {
	for _, a := range []Availability{
		AvailabilityNotFound, AvailabilityStale, AvailabilityNoAccess,
		AvailabilityMalformed, AvailabilityReady,
	} {
		if a.String() == "" || a.String() == "unknown" {
			t.Errorf("Availability(%d) has no log-friendly name", int(a))
		}
	}
}

// The stopped-server case from the field: the server unit removed
// /run/loombre on stop, so the primary is gone and the search reaches the
// 0750 data dir, where EACCES must read as "not running" — never as a
// permissions hint (the old behaviour told the user to join group loombre).
func TestResolveFallbackPermissionDeniedIsNotRunning(t *testing.T) {
	skipOnWindows(t)
	got := Resolve(Options{
		Dirs: []string{"/run/loombre"},
		ReadFile: func(name string) ([]byte, error) {
			if strings.HasPrefix(name, "/run/loombre/") {
				return nil, fs.ErrNotExist
			}
			return nil, fs.ErrPermission
		},
		Stat:     func(string) (fs.FileInfo, error) { return nil, fs.ErrNotExist },
		Username: func() string { return "ada" },
	})
	if got.Availability != AvailabilityNotFound {
		t.Fatalf("Availability = %v (%v)", got.Availability, got.Err)
	}
	if got.Access != nil {
		t.Fatalf("no permissions hint for the data-dir fallback: %+v", got.Access)
	}
	if got.Dir != DataDirFallback {
		t.Fatalf("Dir = %q", got.Dir)
	}
}

// A primary directory that exists but has no discovery file yet (the
// server is booting, or the setup step ran and the server has not written
// its files) ends the search — the fallback must not be consulted.
func TestResolveExistingPrimaryWithoutFileStopsTheSearch(t *testing.T) {
	fallbackTouched := false
	got := Resolve(Options{
		Dirs: []string{"/run/loombre"},
		ReadFile: func(name string) ([]byte, error) {
			if strings.HasPrefix(name, DataDirFallback) {
				fallbackTouched = true
				return discoveryJSON(t, 54217, 4242, LoopbackHost), nil
			}
			return nil, fs.ErrNotExist
		},
		Stat: func(name string) (fs.FileInfo, error) {
			if name == "/run/loombre" {
				return fakeFile{name: "loombre"}, nil
			}
			return nil, fs.ErrNotExist
		},
		Live: func(int) bool { return true },
	})
	if got.Availability != AvailabilityNotFound {
		t.Fatalf("Availability = %v", got.Availability)
	}
	if fallbackTouched {
		t.Fatal("the fallback must not be read once an existing primary directory has answered")
	}
	if got.Dir != "/run/loombre" {
		t.Fatalf("Dir = %q", got.Dir)
	}
}

// With no primary directory at all, the fallback still serves a --no-systemd
// install whose files ARE readable.
func TestResolveFallbackReadableWorks(t *testing.T) {
	skipOnWindows(t)
	got := Resolve(Options{
		Dirs: []string{"/run/loombre"},
		ReadFile: func(name string) ([]byte, error) {
			switch {
			case strings.HasPrefix(name, "/run/loombre/"):
				return nil, fs.ErrNotExist
			case name == filepath.Join(DataDirFallback, TokenFilename):
				return []byte("abc123\n"), nil
			default:
				return discoveryJSON(t, 54217, 4242, LoopbackHost), nil
			}
		},
		Stat: func(string) (fs.FileInfo, error) { return nil, fs.ErrNotExist },
		Live: func(int) bool { return true },
	})
	if got.Availability != AvailabilityReady || got.Dir != DataDirFallback || got.Token != "abc123" {
		t.Fatalf("got %+v", got)
	}
}

// FallbackDir "" disables the fallback entirely.
func TestResolveFallbackCanBeDisabled(t *testing.T) {
	none := ""
	got := Resolve(Options{
		Dirs:        []string{"/run/loombre"},
		FallbackDir: &none,
		ReadFile:    func(string) ([]byte, error) { return discoveryJSON(t, 54217, 4242, LoopbackHost), nil },
		Live:        func(int) bool { return true },
	})
	if got.Availability != AvailabilityReady || got.Dir != "/run/loombre" {
		t.Fatalf("got %+v", got)
	}
}
