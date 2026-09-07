// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/discovery.go
//
// Finds the discovery+token file pair and turns them into something the
// HTTP client can use — or into a typed, ACTIONABLE reason it cannot.
//
// The reasons matter more here than on the other two platforms. On Linux
// the server writes the token 0640 owned by an admin group (apps/server's
// posix-permissions.ts) inside a 0750 directory, and the tray runs as the
// desktop user. A user who is not in that group gets EACCES and, without
// this distinction, would see an indistinguishable "Loombre is not
// running" while the server was in fact healthy — the single most
// confusing failure this client can have. So "present but unreadable" is
// its own Availability, carrying the exact `usermod` command that fixes it.
//
// Every filesystem touch goes through an injectable seam (Options) for the
// same reason DiscoveryReader.swift splits `resolve` from `load`: the
// permission and staleness branches must be testable deterministically, on
// any OS, as any user — a test that chmods a file cannot prove the EACCES
// branch when the suite happens to run as root in a container.

package ipc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// Availability is why (or whether) the tray can talk to the server.
type Availability int

const (
	// AvailabilityNotFound: no discovery file in any candidate directory.
	AvailabilityNotFound Availability = iota
	// AvailabilityStale: a discovery file exists but its pid is dead —
	// the server died without cleaning up after itself.
	AvailabilityStale
	// AvailabilityNoAccess: the files exist but this user may not read
	// them. The only state that is fixable by the user, and the only one
	// with its own UI text.
	AvailabilityNoAccess
	// AvailabilityMalformed: readable but not a discovery file this
	// client understands (torn write during a server restart, truncated
	// file, empty token).
	AvailabilityMalformed
	// AvailabilityReady: BaseURL and Token are usable.
	AvailabilityReady
)

func (a Availability) String() string {
	switch a {
	case AvailabilityNotFound:
		return "not-found"
	case AvailabilityStale:
		return "stale"
	case AvailabilityNoAccess:
		return "no-access"
	case AvailabilityMalformed:
		return "malformed"
	case AvailabilityReady:
		return "ready"
	default:
		return "unknown"
	}
}

// Access is everything needed to tell a user how to fix an EACCES.
type Access struct {
	// Path that could not be read (the token file, or the directory when
	// the directory itself was not traversable).
	Path string
	// Group owning that path — a name when it resolved, the numeric gid
	// otherwise, and "" when even stat failed.
	Group string
	// Username the tray is running as.
	Username string
}

// UsermodCommand is the fix, verbatim, for a user to paste.
func (a Access) UsermodCommand() string {
	group := a.Group
	if group == "" {
		group = "<group>"
	}
	name := a.Username
	if name == "" {
		name = "$USER"
	}
	return fmt.Sprintf("sudo usermod -aG %s %s", group, name)
}

// Discovery is the result of one resolution attempt.
type Discovery struct {
	Availability Availability
	// Dir the discovery file was found in ("" when none was).
	Dir     string
	File    DiscoveryFile
	Token   string
	BaseURL string
	// Access is set only for AvailabilityNoAccess.
	Access *Access
	// Err carries the underlying cause for logging; never nil for a
	// non-Ready result except AvailabilityNotFound.
	Err error
}

// Options are the injectable seams. Every nil field gets the real
// implementation, so production callers pass only Dirs.
type Options struct {
	// Dirs are the primary candidates (DefaultDirs when nil).
	Dirs []string
	// FallbackDir is searched after every primary candidate, with the
	// data-directory rules described at DataDirFallback ("" disables the
	// fallback; nil-Options callers get DataDirFallback).
	FallbackDir *string
	Live        func(pid int) bool
	ReadFile    func(name string) ([]byte, error)
	Stat        func(name string) (fs.FileInfo, error)
	LookupGroup func(gid string) (string, error)
	Username    func() string
}

func (o Options) withDefaults() Options {
	if o.Dirs == nil {
		o.Dirs = DefaultDirs(os.Getenv)
	}
	if o.FallbackDir == nil {
		fallback := DataDirFallback
		o.FallbackDir = &fallback
	}
	if o.Live == nil {
		o.Live = processAlive
	}
	if o.ReadFile == nil {
		o.ReadFile = os.ReadFile
	}
	if o.Stat == nil {
		o.Stat = func(name string) (fs.FileInfo, error) { return os.Stat(name) }
	}
	if o.LookupGroup == nil {
		o.LookupGroup = func(gid string) (string, error) {
			g, err := user.LookupGroupId(gid)
			if err != nil {
				return "", err
			}
			return g.Name, nil
		}
	}
	if o.Username == nil {
		o.Username = currentUsername
	}
	return o
}

// DataDirFallback is the default data directory, searched LAST and with
// different rules (see Resolve): it is 0750 and owned by the service
// account by design, so a permission error there says nothing about the
// server — it is reported as "not running", never as "no access". It is
// what a --no-systemd install or a dev run with LOOMBRE_DATA_DIR uses.
const DataDirFallback = "/var/lib/loombre"

// DefaultDirs is the PRIMARY candidate search order: LOOMBRE_IPC_DIR
// first when set (the escape hatch for a custom layout, and what the tests
// and dev runs use), then /run/loombre, the directory the server unit's
// setup step creates for exactly this. DataDirFallback is appended by
// Resolve, not here. A primary directory that EXISTS ends the search: a
// discovery file missing from it means the server is booting or stopped,
// not that the files live somewhere else.
func DefaultDirs(getenv func(string) string) []string {
	dirs := make([]string, 0, 2)
	if getenv != nil {
		if custom := strings.TrimSpace(getenv("LOOMBRE_IPC_DIR")); custom != "" {
			dirs = append(dirs, custom)
		}
	}
	return append(dirs, "/run/loombre")
}

// Resolve walks the primary candidates, then the data-dir fallback, and
// reports the first conclusive answer.
//
// Two rules keep a stopped server from masquerading as a permissions
// problem (the field report: the server unit removes /run/loombre on stop,
// the search fell through to the 0750 data dir, EACCES there was reported
// as "the server is running, add yourself to group loombre" — wrong twice
// over, and harmful advice):
//   - a PRIMARY directory that exists but holds no discovery file ends
//     the search as "not running" (the server is booting, or stopped
//     before its stop step removed the directory) — the fallback is never
//     consulted past an existing primary;
//   - EACCES in the FALLBACK is "not running", not "no access": that
//     directory is unreadable by design, and the fix for a real
//     permissions problem lives with the primary directory's group.
func Resolve(opts Options) Discovery {
	o := opts.withDefaults()
	candidates := make([]string, 0, len(o.Dirs)+1)
	candidates = append(candidates, o.Dirs...)
	fallback := ""
	if o.FallbackDir != nil {
		fallback = *o.FallbackDir
	}
	if fallback != "" {
		candidates = append(candidates, fallback)
	}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		isFallback := dir == fallback
		discoveryPath := filepath.Join(dir, DiscoveryFilename)
		tokenPath := filepath.Join(dir, TokenFilename)

		raw, err := o.ReadFile(discoveryPath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				if !isFallback {
					if _, statErr := o.Stat(dir); statErr == nil {
						// The directory is there, the file is not: the
						// server is booting or stopped. Nothing further
						// down the list can know better.
						return Discovery{Availability: AvailabilityNotFound, Dir: dir}
					}
				}
				continue
			}
			if errors.Is(err, fs.ErrPermission) && isFallback {
				return Discovery{Availability: AvailabilityNotFound, Dir: dir, Err: err}
			}
			if errors.Is(err, fs.ErrPermission) {
				// Two shapes hide behind one errno. In /run/loombre the
				// directory is 0755 and BOTH files are 0640 owned by the
				// admin group, so the discovery file itself is the thing
				// this user may not read — stat works, and the hint must
				// name ITS group (wheel/sudo), not the directory's
				// (loombre). Only when the directory is 0750 and not
				// traversable does the stat fail too, and the hint falls
				// back to the directory.
				return Discovery{
					Availability: AvailabilityNoAccess,
					Dir:          dir,
					Access:       o.accessHintFirst(discoveryPath, dir),
					Err:          err,
				}
			}
			return Discovery{Availability: AvailabilityMalformed, Dir: dir, Err: err}
		}

		var file DiscoveryFile
		if err := json.Unmarshal(raw, &file); err != nil {
			// A torn read: the server truncates-then-writes each file
			// separately, so a poll can land mid-write on every restart.
			// Not an error state — the next poll 3s later will succeed.
			return Discovery{Availability: AvailabilityMalformed, Dir: dir, Err: err}
		}
		if file.Host != LoopbackHost {
			return Discovery{
				Availability: AvailabilityMalformed,
				Dir:          dir,
				Err:          fmt.Errorf("discovery host %q is not %s", file.Host, LoopbackHost),
			}
		}
		if file.Port <= 0 || file.Port > 65535 {
			return Discovery{
				Availability: AvailabilityMalformed,
				Dir:          dir,
				Err:          fmt.Errorf("discovery port %d out of range", file.Port),
			}
		}

		if !o.Live(file.PID) {
			return Discovery{
				Availability: AvailabilityStale,
				Dir:          dir,
				File:         file,
				Err:          fmt.Errorf("discovery pid %d is not running", file.PID),
			}
		}

		tokenBytes, err := o.ReadFile(tokenPath)
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				return Discovery{
					Availability: AvailabilityNoAccess,
					Dir:          dir,
					File:         file,
					Access:       o.accessHint(tokenPath),
					Err:          err,
				}
			}
			return Discovery{Availability: AvailabilityMalformed, Dir: dir, File: file, Err: err}
		}
		// transport.ts: "raw UTF-8 text (no JSON wrapper, no trailing
		// newline required)". The token is hex, so trimming all
		// surrounding whitespace is safe and survives a writer that used
		// a shell echo.
		token := strings.TrimSpace(string(tokenBytes))
		if token == "" {
			return Discovery{
				Availability: AvailabilityMalformed,
				Dir:          dir,
				File:         file,
				Err:          fmt.Errorf("%s is empty", tokenPath),
			}
		}

		return Discovery{
			Availability: AvailabilityReady,
			Dir:          dir,
			File:         file,
			Token:        token,
			BaseURL:      fmt.Sprintf("http://%s:%d", file.Host, file.Port),
		}
	}
	return Discovery{Availability: AvailabilityNotFound}
}

// accessHint turns "cannot read path" into "add yourself to this group".
// Best-effort by construction: every lookup that fails just leaves its
// field empty, and UsermodCommand renders a placeholder — a degraded hint
// still beats a bare permission error.
func (o Options) accessHint(path string) *Access {
	hint := &Access{Path: path, Username: o.Username()}
	info, err := o.Stat(path)
	if err != nil {
		return hint
	}
	gid, ok := fileGroupID(info)
	if !ok {
		return hint
	}
	hint.Group = gid
	if name, err := o.LookupGroup(gid); err == nil && name != "" {
		hint.Group = name
	}
	return hint
}

// accessHintFirst hints off the first path that can be stat'd — the file
// when its directory is traversable, the directory otherwise — so the
// named group is the one that actually gates the read.
func (o Options) accessHintFirst(paths ...string) *Access {
	for _, candidate := range paths {
		if _, err := o.Stat(candidate); err == nil {
			return o.accessHint(candidate)
		}
	}
	return o.accessHint(paths[0])
}

func currentUsername() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if name := os.Getenv("USER"); name != "" {
		return name
	}
	return os.Getenv("LOGNAME")
}
