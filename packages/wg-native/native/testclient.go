// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native/testclient.go
//
// WgTestClientFetch: a SEPARATE, ephemeral client-side wireguard-go
// device+netstack used only by tests as the loopback peer (R11 — "a test
// peer connects through netstack and fetches a real endpoint"). Builds one
// short-lived device per call, does exactly one HTTP GET through it, tears
// it down. Deliberately defaults AllowedIPs to 0.0.0.0/0 (NOT the R3
// split-tunnel default a real device config uses) — this is the adversarial
// posture the RG2 containment test needs: even a test client that ASKS to
// route everything through the tunnel must still be refused by the SERVER
// side (server.go's netstack has no forwarding and no other address), so a
// broad client-side AllowedIPs proves the containment guarantee lives on
// the server, not merely in what well-behaved clients request.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const defaultFetchTimeoutMs = 5000
const bodyPrefixLimit = 4096

type clientConfig struct {
	PrivateKey      string   `json:"privateKey"`
	ClientTunnelIP  string   `json:"clientTunnelIp"`
	ServerPublicKey string   `json:"serverPublicKey"`
	ServerEndpoint  string   `json:"serverEndpoint"`
	AllowedIPs      []string `json:"allowedIps,omitempty"`
	TimeoutMs       int      `json:"timeoutMs,omitempty"`
}

type fetchResult struct {
	Status     int    `json:"status"`
	BodyPrefix string `json:"bodyPrefix"`
}

func testClientFetch(cfg clientConfig, url string) (*fetchResult, error) {
	if cfg.PrivateKey == "" {
		return nil, fmt.Errorf("privateKey is required")
	}
	if cfg.ClientTunnelIP == "" {
		return nil, fmt.Errorf("clientTunnelIp is required")
	}
	if cfg.ServerPublicKey == "" {
		return nil, fmt.Errorf("serverPublicKey is required")
	}
	if cfg.ServerEndpoint == "" {
		return nil, fmt.Errorf("serverEndpoint is required")
	}

	privateKeyHex, err := base64KeyToHex(cfg.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("privateKey: %w", err)
	}
	serverPublicKeyHex, err := base64KeyToHex(cfg.ServerPublicKey)
	if err != nil {
		return nil, fmt.Errorf("serverPublicKey: %w", err)
	}
	clientAddr, err := netip.ParseAddr(cfg.ClientTunnelIP)
	if err != nil {
		return nil, fmt.Errorf("clientTunnelIp: %w", err)
	}

	allowedIPs := cfg.AllowedIPs
	if len(allowedIPs) == 0 {
		allowedIPs = []string{"0.0.0.0/0"}
	}

	uapi := "private_key=" + privateKeyHex + "\n"
	uapi += "public_key=" + serverPublicKeyHex + "\n"
	uapi += "endpoint=" + cfg.ServerEndpoint + "\n"
	for _, cidr := range allowedIPs {
		uapi += "allowed_ip=" + cidr + "\n"
	}

	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{clientAddr}, nil, device.DefaultMTU)
	if err != nil {
		return nil, fmt.Errorf("failed to create netstack TUN: %w", err)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg-native(test-client): "))
	defer dev.Close()

	if err := dev.IpcSet(uapi); err != nil {
		return nil, fmt.Errorf("failed to configure test client device: %w", err)
	}
	if err := dev.Up(); err != nil {
		return nil, fmt.Errorf("failed to bring test client device up: %w", err)
	}

	timeoutMs := cfg.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultFetchTimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return tnet.DialContext(ctx, network, addr)
			},
		},
		Timeout: time.Duration(timeoutMs) * time.Millisecond,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, bodyPrefixLimit))
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	return &fetchResult{Status: resp.StatusCode, BodyPrefix: string(body)}, nil
}

// WgTestClientFetch does real blocking network I/O (a WG handshake + a full
// HTTP round trip) — koffi's SYNCHRONOUS call mode was empirically proven
// (this lane's dedicated debugging session, see STATE.md's WG1 report) to
// starve this library's OWN background goroutines (wireguard-go's
// encryption/decryption/receive routines) for the ENTIRE duration of a
// long synchronous cgo call from Node: the WG cryptographic handshake and
// even the TCP 3-way handshake would complete, but the actual HTTP
// request/response bytes would not move until the call's context deadline
// fired and torn-down state forced a flush. koffi's `.async()` call mode
// (src/loader.ts — REQUIRED for this export, never call it synchronously)
// runs the FFI call on a libuv worker thread instead and resolved this
// completely, verified by an identical reproduction that passed instantly.
// This function's OWN body stays plain/synchronous Go — the fix lives
// entirely on the JS call-site, not here.
//
//export WgTestClientFetch
func WgTestClientFetch(clientConfigJSON *C.char, url *C.char) *C.char {
	var cfg clientConfig
	if err := json.Unmarshal([]byte(C.GoString(clientConfigJSON)), &cfg); err != nil {
		return respondErr(fmt.Errorf("invalid client config JSON: %w", err))
	}
	result, err := testClientFetch(cfg, C.GoString(url))
	if err != nil {
		return respondErr(err)
	}
	return respondOK(result)
}
