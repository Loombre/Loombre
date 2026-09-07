// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/contract.go
//
// Mirrors packages/controller-ipc/src/transport.ts + contract-version.ts —
// the FROZEN controller<->server contract this tray is a client of. The
// Windows tray (Loombre.Tray.Ipc/Transport.cs) and the macOS menubar
// (LoombreIPCKit/Transport.swift) carry the same constants; there is no
// codegen from the TS source for any of the three, so a bump on the TS
// side needs a matching manual edit in all of them. StatusResponse's
// MatchesContractVersion (wire.go) is the runtime check that makes a
// forgotten bump visible to an operator instead of silently misbehaving.

package ipc

const (
	// ContractVersion is this client's CONTROLLER_IPC_CONTRACT_VERSION.
	ContractVersion = 1

	// BasePath carries the coarse "v1"; ContractVersion is the
	// fine-grained number for additive changes within it.
	BasePath = "/ipc/v1"

	// LoopbackHost is the only host the v1 transport ever binds — the
	// discovery file's `host` field is schema-pinned to this literal.
	LoopbackHost = "127.0.0.1"

	// DiscoveryFilename holds the ephemeral port + pid as JSON.
	// World-readable by design: a port number is not a secret.
	DiscoveryFilename = "controller-ipc.json"

	// TokenFilename holds the bearer token as raw text. On Linux the
	// server writes it 0640 owned by an admin group (apps/server's
	// posix-permissions.ts), which is why "present but unreadable" is a
	// first-class state this client reports rather than a crash.
	TokenFilename = "controller-ipc.token"

	AuthHeader = "Authorization"
	AuthScheme = "Bearer"
)
