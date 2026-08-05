// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native/keys.go
//
// WireGuard's own wire/config convention (wg-quick, wg(8), every client
// app) represents Curve25519 keys as standard base64 (44 chars, 32 raw
// bytes) — that is what packages/wg-native's TS side generates (node:crypto
// x25519) and what this library's JSON config/peer inputs and JSON status
// outputs use throughout. wireguard-go's OWN UAPI configuration protocol
// (device.IpcSet/IpcGet, see device/uapi.go) instead speaks lower-case HEX
// (64 chars) — every function below converts at that ONE boundary so no
// other file in this package needs to think about the mismatch.
package main

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

const keyLenBytes = 32

func base64KeyToHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("invalid base64 key: %w", err)
	}
	if len(raw) != keyLenBytes {
		return "", fmt.Errorf("invalid key length: got %d bytes, want %d", len(raw), keyLenBytes)
	}
	return hex.EncodeToString(raw), nil
}

func hexKeyToBase64(hexKey string) (string, error) {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return "", fmt.Errorf("invalid hex key: %w", err)
	}
	if len(raw) != keyLenBytes {
		return "", fmt.Errorf("invalid key length: got %d bytes, want %d", len(raw), keyLenBytes)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
