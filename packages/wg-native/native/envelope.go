// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native/envelope.go
//
// Every exported C function in this library (main.go) returns a
// heap-allocated C string owning ONE JSON envelope: {"ok":true,"data":...}
// on success, {"ok":false,"error":"..."} on failure. cgo cannot propagate a
// Go error or throw a JS exception across the FFI boundary directly, so a
// uniform envelope is the standard c-shared pattern — the TS loader
// (src/loader.ts) decodes it, frees the C buffer via WgFreeString, and
// turns ok:false into a real thrown Error on the Node side.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"unsafe"
)

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

// toCString allocates a NEW C-owned copy of s (C.CString uses C's malloc,
// matching WgFreeString's C.free below — never Go's own allocator, which a
// cgo caller must never free directly).
func toCString(s string) *C.char {
	return C.CString(s)
}

func respondOK(data any) *C.char {
	raw, err := json.Marshal(data)
	if err != nil {
		return respondErr(err)
	}
	env := envelope{OK: true, Data: raw}
	out, err := json.Marshal(env)
	if err != nil {
		// Unreachable in practice (envelope is trivially marshalable), but
		// never leave the caller with a null pointer.
		return toCString(`{"ok":false,"error":"internal: failed to marshal envelope"}`)
	}
	return toCString(string(out))
}

func respondErr(err error) *C.char {
	env := envelope{OK: false, Error: err.Error()}
	out, marshalErr := json.Marshal(env)
	if marshalErr != nil {
		return toCString(`{"ok":false,"error":"internal: failed to marshal error envelope"}`)
	}
	return toCString(string(out))
}

func respondErrString(msg string) *C.char {
	env := envelope{OK: false, Error: msg}
	out, err := json.Marshal(env)
	if err != nil {
		return toCString(`{"ok":false,"error":"internal: failed to marshal error envelope"}`)
	}
	return toCString(string(out))
}

//export WgFreeString
func WgFreeString(ptr *C.char) {
	if ptr == nil {
		return
	}
	C.free(unsafe.Pointer(ptr))
}
