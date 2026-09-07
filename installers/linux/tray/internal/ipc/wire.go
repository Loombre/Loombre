// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/wire.go
//
// Go mirrors of the frozen wire shapes in packages/controller-ipc/src/*.ts
// (transport.ts, process-info.ts, status.ts, server-lifecycle.ts,
// open-web-target.ts, crash-files.ts, error-body.ts) plus the one type
// those import from @loombre/provisioning (ProvisioningStatus).
//
// Nullable wire fields are POINTERS, not zero values: `pid: null` and
// `pid: 0` are different statements about the world, and collapsing them
// would make "stopped" indistinguishable from "running as pid 0". The
// fixture-parity test (wire_test.go) round-trips every canonical value in
// installers/macos/menubar/fixtures.json through these types and back,
// which is what proves this client agrees with the Swift and C# ones
// field-for-field.

package ipc

// ProcessState mirrors process-info.ts's ProcessState union.
type ProcessState string

const (
	ProcessStopped  ProcessState = "stopped"
	ProcessStarting ProcessState = "starting"
	ProcessRunning  ProcessState = "running"
	ProcessStopping ProcessState = "stopping"
	ProcessCrashed  ProcessState = "crashed"
)

// ProcessInfo mirrors process-info.ts's ProcessInfo.
type ProcessInfo struct {
	State ProcessState `json:"state"`
	// PID is set while state is starting/running/stopping; null otherwise.
	PID *int64 `json:"pid"`
	// StartedAtMs is null until the process has started at least once.
	StartedAtMs *int64 `json:"startedAtMs"`
	Version     string `json:"version"`
}

// ProvisioningState mirrors packages/provisioning's ProvisioningState.
type ProvisioningState string

const (
	ProvisioningAbsent       ProvisioningState = "absent"
	ProvisioningProvisioning ProvisioningState = "provisioning"
	ProvisioningReady        ProvisioningState = "ready"
	ProvisioningUpgrading    ProvisioningState = "upgrading"
	ProvisioningCorrupt      ProvisioningState = "corrupt"
	ProvisioningExternal     ProvisioningState = "external"
)

// ProvisioningStatus is the embedded-PostgreSQL status GET /status passes
// through verbatim. Mirrored here for the same reason the Swift client
// mirrors it: IpcStatusResponse embeds it, so decoding /status needs it.
type ProvisioningStatus struct {
	State       ProvisioningState `json:"state"`
	PgVersion   *string           `json:"pgVersion"`
	DataDir     *string           `json:"dataDir"`
	LastCheckMs int64             `json:"lastCheckMs"`
	Detail      *string           `json:"detail,omitempty"`
}

// StatusResponse mirrors status.ts's IpcStatusResponse (GET /status).
type StatusResponse struct {
	IPCContractVersion int         `json:"ipcContractVersion"`
	Server             ProcessInfo `json:"server"`
	Worker             ProcessInfo `json:"worker"`
	// WebURL is null while the server is not serving the web client.
	WebURL       *string            `json:"webUrl"`
	Provisioning ProvisioningStatus `json:"provisioning"`
}

// MatchesContractVersion reports whether the server speaks the contract
// version this build was written against. A newer server is not
// automatically fatal (changes within v1 are additive by design) but the
// tray surfaces the mismatch rather than trusting a field shape the peer
// may not actually have.
func (s *StatusResponse) MatchesContractVersion() bool {
	return s != nil && s.IPCContractVersion == ContractVersion
}

// ServerActionResponse mirrors server-lifecycle.ts's IpcServerActionResponse.
type ServerActionResponse struct {
	// Accepted is false when the request was a no-op.
	Accepted bool         `json:"accepted"`
	State    ProcessState `json:"state"`
}

// OpenWebTargetResponse mirrors open-web-target.ts.
type OpenWebTargetResponse struct {
	URL string `json:"url"`
}

// CrashFileEntry mirrors crash-files.ts's CrashFileEntry.
type CrashFileEntry struct {
	Path    string `json:"path"`
	MtimeMs int64  `json:"mtimeMs"`
}

// CrashFilesResponse mirrors crash-files.ts's CrashFilesResponse.
type CrashFilesResponse struct {
	Files []CrashFileEntry `json:"files"`
}

// ErrorCode mirrors error-body.ts's closed IpcErrorCode enum.
type ErrorCode string

const (
	ErrorUnauthorized         ErrorCode = "unauthorized"
	ErrorServerAlreadyRunning ErrorCode = "server-already-running"
	ErrorServerNotRunning     ErrorCode = "server-not-running"
	ErrorWebURLUnavailable    ErrorCode = "web-url-unavailable"
	ErrorInternal             ErrorCode = "internal-error"
)

// ErrorBody mirrors error-body.ts's IpcErrorBody — the RFC-9457-shaped
// body every non-2xx response in this contract carries.
type ErrorBody struct {
	Title  string    `json:"title"`
	Status int       `json:"status"`
	Code   ErrorCode `json:"code"`
	Detail string    `json:"detail,omitempty"`
}

// DiscoveryFile mirrors transport.ts's IpcDiscoveryFile.
type DiscoveryFile struct {
	Port int    `json:"port"`
	Host string `json:"host"`
	// PID of the server process that wrote this file, so a controller can
	// tell a stale file from a live one without making an HTTP call.
	PID         int   `json:"pid"`
	StartedAtMs int64 `json:"startedAtMs"`
}
