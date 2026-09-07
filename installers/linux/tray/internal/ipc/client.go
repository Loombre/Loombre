// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/ipc/client.go
//
// HTTP client for the v1 loopback transport. One method per contract
// operation, deliberately without a public generic call() helper, so every
// operation stays independently typed at its call site (same shape as
// IPCClient.swift and IpcClient.cs).
//
// THERE IS NO StartServer METHOD, ON PURPOSE. transport.ts's
// IPC_SERVER_START_SEMANTICS documents that POST /ipc/v1/server/start is
// served by the server process itself: it is reachable only while the
// server is already up, and returns 409 server-already-running every time
// it is reached at all. Starting a stopped server goes through systemd
// (internal/systemd). Omitting the method makes the wrong call impossible
// rather than merely discouraged.

package ipc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultTimeout bounds a single request. The poll loop runs every 3s, so
// a request that has not answered in 2s is already stale — better to fail
// the tick and re-ask than to queue behind a hung socket.
const DefaultTimeout = 2 * time.Second

// maxErrorBodyBytes caps how much of a non-2xx body is read before giving
// up on parsing it: the contract's error bodies are tiny, and a controller
// must never let a misbehaving peer stream unbounded data into a tray.
const maxErrorBodyBytes = 64 * 1024

// APIError is a non-2xx response. Body is nil when the payload was not a
// contract error body (a foreign or broken peer), in which case only
// StatusCode is meaningful.
type APIError struct {
	StatusCode int
	Body       *ErrorBody
}

func (e *APIError) Error() string {
	if e.Body == nil {
		return fmt.Sprintf("ipc: unexpected HTTP status %d", e.StatusCode)
	}
	if e.Body.Detail != "" {
		return fmt.Sprintf("ipc: %s (%s): %s", e.Body.Title, e.Body.Code, e.Body.Detail)
	}
	return fmt.Sprintf("ipc: %s (%s)", e.Body.Title, e.Body.Code)
}

// Code returns the contract error code, or "" when the body did not parse.
func (e *APIError) Code() ErrorCode {
	if e.Body == nil {
		return ""
	}
	return e.Body.Code
}

// Client talks to one discovered server instance.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewClient builds a client for a Discovery result's BaseURL and Token.
func NewClient(baseURL, token string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		// No shared transport: the server's port changes on every restart,
		// so pooled keep-alive connections to a dead port would just be
		// retried failures. One client per discovery is the cheap,
		// obviously-correct option at a 3s poll rate.
		http: &http.Client{Timeout: timeout},
	}
}

// NewClientFor builds a client straight from a Ready Discovery.
func NewClientFor(d Discovery, timeout time.Duration) *Client {
	return NewClient(d.BaseURL, d.Token, timeout)
}

// Status is GET /ipc/v1/status.
func (c *Client) Status(ctx context.Context) (*StatusResponse, error) {
	return doJSON[StatusResponse](ctx, c, http.MethodGet, "/status", nil)
}

// StopServer is POST /ipc/v1/server/stop. The server flushes this 200 and
// then SIGTERMs itself, so the caller should re-poll shortly after.
func (c *Client) StopServer(ctx context.Context) (*ServerActionResponse, error) {
	return doJSON[ServerActionResponse](ctx, c, http.MethodPost, "/server/stop", []byte("{}"))
}

// OpenWebTarget is GET /ipc/v1/open-web-target. Returns an *APIError with
// code web-url-unavailable when the server is not serving the web client.
func (c *Client) OpenWebTarget(ctx context.Context) (*OpenWebTargetResponse, error) {
	return doJSON[OpenWebTargetResponse](ctx, c, http.MethodGet, "/open-web-target", nil)
}

// CrashFiles is GET /ipc/v1/crash-files.
func (c *Client) CrashFiles(ctx context.Context) (*CrashFilesResponse, error) {
	return doJSON[CrashFilesResponse](ctx, c, http.MethodGet, "/crash-files", nil)
}

func doJSON[T any](ctx context.Context, c *Client, method, path string, body []byte) (*T, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+BasePath+path, reader)
	if err != nil {
		return nil, fmt.Errorf("ipc: build %s %s: %w", method, path, err)
	}
	req.Header.Set(AuthHeader, AuthScheme+" "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ipc: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{StatusCode: resp.StatusCode}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
		if readErr == nil {
			var parsed ErrorBody
			if json.Unmarshal(raw, &parsed) == nil && parsed.Code != "" {
				apiErr.Body = &parsed
			}
		}
		return nil, apiErr
	}

	var out T
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("ipc: decode %s %s: %w", method, path, err)
	}
	return &out, nil
}
