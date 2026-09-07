// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/wire_test.go
//
// Wire parity with the other two controller clients. installers/macos/
// menubar/fixtures.json holds the CANONICAL values for every shape in the
// frozen contract (validated there against the TS package's real Ajv
// schemas by verify-fixtures.mjs), so decoding that same file — not a
// hand-copied Go literal — is what proves this client agrees with the
// Swift and C# ones rather than merely agreeing with itself.
//
// Each fixture is also re-encoded and compared to the original JSON as
// generic maps: a dropped field, a renamed json tag, or a nullable field
// collapsed to a zero value all fail here, which a decode-only assertion
// would happily miss.

package ipc

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Relative to this package directory. The macOS fixtures are the shared
// source of truth; a moved or deleted file must fail loudly, never
// silently skip the parity check.
const fixturesPath = "../../../../macos/menubar/fixtures.json"

type fixtureSet map[string]json.RawMessage

func loadFixtures(t *testing.T) fixtureSet {
	t.Helper()
	raw, err := os.ReadFile(fixturesPath)
	if err != nil {
		t.Fatalf("read shared contract fixtures %s: %v (the macOS menubar fixtures are this test's source of truth — if they moved, update fixturesPath)", fixturesPath, err)
	}
	var set fixtureSet
	if err := json.Unmarshal(raw, &set); err != nil {
		t.Fatalf("parse %s: %v", fixturesPath, err)
	}
	if len(set) == 0 {
		t.Fatalf("%s is empty", fixturesPath)
	}
	return set
}

func (f fixtureSet) get(t *testing.T, key string) json.RawMessage {
	t.Helper()
	raw, ok := f[key]
	if !ok {
		t.Fatalf("%s has no %q fixture", fixturesPath, key)
	}
	return raw
}

// keysWithPrefix returns every fixture key starting with prefix, sorted so
// failures name a stable case.
func (f fixtureSet) keysWithPrefix(prefix string) []string {
	var keys []string
	for k := range f {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// roundTrip decodes raw into T, re-encodes it, and asserts the two JSON
// documents are structurally identical.
func roundTrip[T any](t *testing.T, name string, raw json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s: decode: %v", name, err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("%s: re-encode: %v", name, err)
	}
	var before, after map[string]any
	if err := json.Unmarshal(raw, &before); err != nil {
		t.Fatalf("%s: re-read fixture: %v", name, err)
	}
	if err := json.Unmarshal(encoded, &after); err != nil {
		t.Fatalf("%s: re-read encoded: %v", name, err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Errorf("%s: round-trip lost or changed fields\n before: %s\n  after: %s", name, raw, encoded)
	}
	return value
}

func TestDiscoveryFileFixture(t *testing.T) {
	f := loadFixtures(t)
	got := roundTrip[DiscoveryFile](t, "discoveryFile", f.get(t, "discoveryFile"))
	if got.Port != 54217 || got.Host != LoopbackHost || got.PID != 4242 || got.StartedAtMs != 1732400000000 {
		t.Fatalf("discoveryFile mismatch: %+v", got)
	}
}

func TestEveryProcessInfoFixtureDecodes(t *testing.T) {
	f := loadFixtures(t)
	keys := f.keysWithPrefix("processInfo")
	if len(keys) == 0 {
		t.Fatalf("%s carries no processInfo* fixtures", fixturesPath)
	}
	for _, key := range keys {
		info := roundTrip[ProcessInfo](t, key, f.get(t, key))
		if info.State == "" {
			t.Errorf("%s: empty state", key)
		}
		if info.Version == "" {
			t.Errorf("%s: empty version", key)
		}
		// pid/startedAtMs are pointers precisely so null survives the
		// round trip; a stopped process reports both as null.
		if info.State == ProcessStopped && (info.PID != nil || info.StartedAtMs != nil) {
			t.Errorf("%s: stopped process should carry null pid/startedAtMs, got %+v", key, info)
		}
		if info.State == ProcessRunning && info.PID == nil {
			t.Errorf("%s: running process should carry a pid", key)
		}
	}
}

func TestEveryProvisioningStatusFixtureDecodes(t *testing.T) {
	f := loadFixtures(t)
	keys := f.keysWithPrefix("provisioningStatus")
	if len(keys) == 0 {
		t.Fatalf("%s carries no provisioningStatus* fixtures", fixturesPath)
	}
	for _, key := range keys {
		status := roundTrip[ProvisioningStatus](t, key, f.get(t, key))
		if status.State == "" {
			t.Errorf("%s: empty state", key)
		}
		if status.LastCheckMs == 0 {
			t.Errorf("%s: missing lastCheckMs", key)
		}
	}
}

func TestStatusResponseHealthyFixture(t *testing.T) {
	f := loadFixtures(t)
	status := roundTrip[StatusResponse](t, "statusResponseHealthy", f.get(t, "statusResponseHealthy"))
	if !status.MatchesContractVersion() {
		t.Fatalf("healthy fixture should match contract v%d, got v%d", ContractVersion, status.IPCContractVersion)
	}
	if status.Server.State != ProcessRunning || status.Worker.State != ProcessRunning {
		t.Fatalf("healthy fixture should have both processes running: %+v", status)
	}
	if status.WebURL == nil || *status.WebURL != "http://localhost:3001" {
		t.Fatalf("healthy fixture webUrl mismatch: %+v", status.WebURL)
	}
	if status.Provisioning.State != ProvisioningExternal {
		t.Fatalf("healthy fixture provisioning mismatch: %+v", status.Provisioning)
	}
}

func TestStatusResponseStoppedFixtureKeepsNulls(t *testing.T) {
	f := loadFixtures(t)
	status := roundTrip[StatusResponse](t, "statusResponseStopped", f.get(t, "statusResponseStopped"))
	if status.Server.State != ProcessStopped {
		t.Fatalf("expected stopped server, got %q", status.Server.State)
	}
	if status.WebURL != nil {
		t.Fatalf("stopped fixture must decode webUrl as nil, got %q", *status.WebURL)
	}
}

func TestStatusResponseCrashedFixture(t *testing.T) {
	f := loadFixtures(t)
	status := roundTrip[StatusResponse](t, "statusResponseCrashed", f.get(t, "statusResponseCrashed"))
	if status.Server.State != ProcessCrashed {
		t.Fatalf("expected crashed server, got %q", status.Server.State)
	}
	if status.Provisioning.State != ProvisioningCorrupt {
		t.Fatalf("expected corrupt provisioning, got %q", status.Provisioning.State)
	}
	if status.Provisioning.Detail == nil || *status.Provisioning.Detail != "checksum-failure" {
		t.Fatalf("expected provisioning detail checksum-failure, got %+v", status.Provisioning.Detail)
	}
}

func TestErrorBodyFixtures(t *testing.T) {
	f := loadFixtures(t)
	unauthorized := roundTrip[ErrorBody](t, "errorBodyUnauthorized", f.get(t, "errorBodyUnauthorized"))
	if unauthorized.Code != ErrorUnauthorized || unauthorized.Status != 401 {
		t.Fatalf("unauthorized fixture mismatch: %+v", unauthorized)
	}
	if unauthorized.Detail == "" {
		t.Fatalf("unauthorized fixture should carry a detail")
	}

	// This is the body POST /server/start ALWAYS returns — the reason this
	// client has no StartServer method at all (client.go's header).
	already := roundTrip[ErrorBody](t, "errorBodyServerAlreadyRunning", f.get(t, "errorBodyServerAlreadyRunning"))
	if already.Code != ErrorServerAlreadyRunning || already.Status != 409 {
		t.Fatalf("server-already-running fixture mismatch: %+v", already)
	}
	if already.Detail != "" {
		t.Fatalf("fixture has no detail; omitempty must keep it out of the round trip")
	}
}

func TestServerActionResponseFixtures(t *testing.T) {
	f := loadFixtures(t)
	accepted := roundTrip[ServerActionResponse](t, "serverActionResponseAccepted", f.get(t, "serverActionResponseAccepted"))
	if !accepted.Accepted || accepted.State != ProcessStarting {
		t.Fatalf("accepted fixture mismatch: %+v", accepted)
	}
	noop := roundTrip[ServerActionResponse](t, "serverActionResponseNoop", f.get(t, "serverActionResponseNoop"))
	if noop.Accepted || noop.State != ProcessRunning {
		t.Fatalf("noop fixture mismatch: %+v", noop)
	}
}

func TestOpenWebTargetFixture(t *testing.T) {
	f := loadFixtures(t)
	target := roundTrip[OpenWebTargetResponse](t, "openWebTargetResponse", f.get(t, "openWebTargetResponse"))
	if target.URL != "http://localhost:3001" {
		t.Fatalf("openWebTargetResponse mismatch: %+v", target)
	}
}

func TestCrashFilesFixtures(t *testing.T) {
	f := loadFixtures(t)
	files := roundTrip[CrashFilesResponse](t, "crashFilesResponse", f.get(t, "crashFilesResponse"))
	if len(files.Files) != 2 {
		t.Fatalf("expected 2 crash files, got %d", len(files.Files))
	}
	// The contract says the server already sorts newest-first; the client
	// re-sorts defensively (internal/control), so pin the fixture order
	// here to catch a contract change rather than silently absorbing it.
	if files.Files[0].MtimeMs <= files.Files[1].MtimeMs {
		t.Fatalf("crashFilesResponse fixture is no longer newest-first: %+v", files.Files)
	}

	empty := roundTrip[CrashFilesResponse](t, "crashFilesResponseEmpty", f.get(t, "crashFilesResponseEmpty"))
	if len(empty.Files) != 0 {
		t.Fatalf("expected empty crash file list, got %+v", empty.Files)
	}
}

func TestContractConstantsMatchTheFrozenPackage(t *testing.T) {
	if ContractVersion != 1 {
		t.Errorf("ContractVersion must track CONTROLLER_IPC_CONTRACT_VERSION (1), got %d", ContractVersion)
	}
	if BasePath != "/ipc/v1" {
		t.Errorf("BasePath = %q", BasePath)
	}
	if DiscoveryFilename != "controller-ipc.json" || TokenFilename != "controller-ipc.token" {
		t.Errorf("discovery filenames drifted: %q / %q", DiscoveryFilename, TokenFilename)
	}
	if AuthHeader != "Authorization" || AuthScheme != "Bearer" {
		t.Errorf("auth constants drifted: %q %q", AuthHeader, AuthScheme)
	}
}
