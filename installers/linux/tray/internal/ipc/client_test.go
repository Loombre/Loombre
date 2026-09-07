// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/client_test.go
//
// Request-shape and response-parsing tests against a real loopback HTTP
// server (httptest), fed the same canonical fixture bodies the wire tests
// decode — the Go equivalent of IPCClientTests.swift's injected transport.

package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const testToken = "0123456789abcdef"

type recordedRequest struct {
	method string
	path   string
	auth   string
	accept string
	body   string
}

func newTestServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*Client, *recordedRequest) {
	t.Helper()
	rec := &recordedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.method = r.Method
		rec.path = r.URL.Path
		rec.auth = r.Header.Get(AuthHeader)
		rec.accept = r.Header.Get("Accept")
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		rec.body = string(buf[:n])
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, testToken, 2*time.Second), rec
}

func writeJSON(t *testing.T, w http.ResponseWriter, status int, raw json.RawMessage) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		t.Fatalf("write response: %v", err)
	}
}

func TestClientStatusSendsBearerTokenAndParsesFixture(t *testing.T) {
	f := loadFixtures(t)
	client, rec := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusOK, f.get(t, "statusResponseHealthy"))
	})

	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if rec.method != http.MethodGet || rec.path != "/ipc/v1/status" {
		t.Fatalf("request = %s %s", rec.method, rec.path)
	}
	if rec.auth != "Bearer "+testToken {
		t.Fatalf("Authorization = %q", rec.auth)
	}
	if !status.MatchesContractVersion() || status.Server.State != ProcessRunning {
		t.Fatalf("status = %+v", status)
	}
}

func TestClientStopServerPostsAnEmptyObject(t *testing.T) {
	f := loadFixtures(t)
	client, rec := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusOK, f.get(t, "serverActionResponseAccepted"))
	})

	action, err := client.StopServer(context.Background())
	if err != nil {
		t.Fatalf("StopServer: %v", err)
	}
	if rec.method != http.MethodPost || rec.path != "/ipc/v1/server/stop" {
		t.Fatalf("request = %s %s", rec.method, rec.path)
	}
	if rec.body != "{}" {
		t.Fatalf("body = %q, want the contract's empty object", rec.body)
	}
	if !action.Accepted {
		t.Fatalf("action = %+v", action)
	}
}

func TestClientOpenWebTargetAndCrashFilesPaths(t *testing.T) {
	f := loadFixtures(t)

	client, rec := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusOK, f.get(t, "openWebTargetResponse"))
	})
	target, err := client.OpenWebTarget(context.Background())
	if err != nil {
		t.Fatalf("OpenWebTarget: %v", err)
	}
	if rec.path != "/ipc/v1/open-web-target" || target.URL == "" {
		t.Fatalf("path = %q, target = %+v", rec.path, target)
	}

	client, rec = newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusOK, f.get(t, "crashFilesResponse"))
	})
	files, err := client.CrashFiles(context.Background())
	if err != nil {
		t.Fatalf("CrashFiles: %v", err)
	}
	if rec.path != "/ipc/v1/crash-files" || len(files.Files) != 2 {
		t.Fatalf("path = %q, files = %+v", rec.path, files.Files)
	}
}

func TestClientParsesContractErrorBodies(t *testing.T) {
	f := loadFixtures(t)
	client, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusUnauthorized, f.get(t, "errorBodyUnauthorized"))
	})

	_, err := client.Status(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T (%v)", err, err)
	}
	if apiErr.StatusCode != http.StatusUnauthorized || apiErr.Code() != ErrorUnauthorized {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if apiErr.Error() == "" {
		t.Fatal("APIError must render something a notification can show")
	}
}

// A 409 web-url-unavailable is a NORMAL answer to "open the web UI" while
// the server is still booting — the caller distinguishes it by code.
func TestClientSurfacesWebUrlUnavailableCode(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, http.StatusConflict, json.RawMessage(
			`{"title":"Web URL unavailable","status":409,"code":"web-url-unavailable"}`))
	})
	_, err := client.OpenWebTarget(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Code() != ErrorWebURLUnavailable {
		t.Fatalf("code = %q", apiErr.Code())
	}
}

// A peer that is not this contract at all (a stray HTTP server on a reused
// port) must degrade to a status code, never a panic or a silent success.
func TestClientHandlesNonContractErrorBody(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>nginx</html>"))
	})
	_, err := client.Status(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Body != nil || apiErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if apiErr.Code() != "" {
		t.Fatalf("unparsed body must have no code, got %q", apiErr.Code())
	}
}

func TestClientHonoursContextCancellation(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writeJSON(t, w, http.StatusOK, json.RawMessage(`{}`))
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Status(ctx); err == nil {
		t.Fatal("a cancelled context must fail the request")
	}
}
