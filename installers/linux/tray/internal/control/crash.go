// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/crash.go
//
// What "Reveal crash files" should DO with a GET /crash-files response —
// pure data, so the empty case is a decision the UI must render (both
// other trays say "No crash files found") and never a silent no-op. An
// empty list is the HEALTHY steady state: the crashes directory is created
// lazily on the first crash, which is exactly why an earlier guard-return
// version of this logic on macOS did nothing at all on every healthy
// install.

package control

import (
	"path"
	"sort"
	"strings"

	"loombre.dev/linux-tray/internal/ipc"
)

// CrashRevealKind distinguishes the two outcomes.
type CrashRevealKind int

const (
	CrashNoneFound CrashRevealKind = iota
	CrashReveal
)

// CrashRevealPlan is what to open and what to say.
type CrashRevealPlan struct {
	Kind CrashRevealKind
	// NewestPath is the most recent crash file.
	NewestPath string
	// Directory holds it — what actually gets opened, since there is no
	// portable "select this file in the file manager" on Linux the way
	// explorer /select and Finder's activateFileViewerSelecting are.
	Directory string
	Count     int
}

// PlanCrashReveal sorts defensively by recency. The contract says the
// server already returns files newest-first; re-sorting here means a
// server that stops honouring that still opens the right directory.
func PlanCrashReveal(files []ipc.CrashFileEntry) CrashRevealPlan {
	if len(files) == 0 {
		return CrashRevealPlan{Kind: CrashNoneFound}
	}
	sorted := make([]ipc.CrashFileEntry, len(files))
	copy(sorted, files)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].MtimeMs > sorted[j].MtimeMs
	})
	newest := sorted[0]
	return CrashRevealPlan{
		Kind:       CrashReveal,
		NewestPath: newest.Path,
		Directory:  path.Dir(newest.Path),
		Count:      len(sorted),
	}
}

// AdminCrashPageURL is where "Reveal crash files" goes when the crash
// directory itself cannot be opened by this user — the packages install
// the data directory 0750 owned by the service account, so a desktop user
// cannot traverse into /var/lib/loombre/crashes at all (the field report:
// KDE said the folder does not exist). The web admin Dashboard's crash
// card lists and shows the same files through the authenticated API,
// which is the honest substitute for a folder the OS will not open.
func AdminCrashPageURL(webURL string) string {
	return strings.TrimRight(webURL, "/") + "/admin"
}
