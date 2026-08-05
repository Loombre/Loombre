// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native/uapi_parse.go
//
// device.IpcGet() (device/uapi.go's IpcGetOperation) returns the WireGuard
// cross-platform configuration protocol's "get" text — see
// https://www.wireguard.com/xplatform/#configuration-protocol. It ALWAYS
// starts with the device's own private_key line (raw hex) when a key is
// set, which this parser deliberately drops on the floor: WgStatus's JSON
// output (server.go's statusResult) never carries the private key or the
// listen_port line raw — R9's no-secrets posture applies here too, even
// though this is an in-process call, not a network response.
package main

import (
	"strconv"
	"strings"
)

type parsedPeer struct {
	publicKeyHex    string
	lastHandshakeMs int64
	rxBytes         int64
	txBytes         int64
}

// parseUAPIStatus walks the get-operation text and returns one parsedPeer
// per public_key= line encountered (a new key line always starts a new
// peer block, mirroring device/uapi.go's own IpcSetOperation parse loop).
func parseUAPIStatus(raw string) ([]parsedPeer, error) {
	var peers []parsedPeer
	var current *parsedPeer
	var handshakeSec int64
	var handshakeNsec int64

	flush := func() {
		if current == nil {
			return
		}
		// Never-handshaked peers report sec=0/nsec=0 (device/uapi.go always
		// emits both lines), which naturally collapses to 0 here too — a
		// real epoch-zero handshake is not a value wireguard-go ever
		// produces, so 0 unambiguously means "never".
		current.lastHandshakeMs = handshakeSec*1000 + handshakeNsec/1_000_000
		peers = append(peers, *current)
	}

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "public_key":
			flush()
			current = &parsedPeer{publicKeyHex: value}
			handshakeSec, handshakeNsec = 0, 0
		case "last_handshake_time_sec":
			if current == nil {
				continue
			}
			handshakeSec, _ = strconv.ParseInt(value, 10, 64)
		case "last_handshake_time_nsec":
			if current == nil {
				continue
			}
			handshakeNsec, _ = strconv.ParseInt(value, 10, 64)
		case "rx_bytes":
			if current == nil {
				continue
			}
			current.rxBytes, _ = strconv.ParseInt(value, 10, 64)
		case "tx_bytes":
			if current == nil {
				continue
			}
			current.txBytes, _ = strconv.ParseInt(value, 10, 64)
		}
	}
	flush()

	return peers, nil
}

// parseListenPort extracts the device's real bound UDP port (0 if the
// device reports none, which should not happen once Up() has succeeded).
func parseListenPort(raw string) (int, error) {
	for _, line := range strings.Split(raw, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || key != "listen_port" {
			continue
		}
		port, err := strconv.Atoi(value)
		if err != nil {
			return 0, err
		}
		return port, nil
	}
	return 0, nil
}
