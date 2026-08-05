// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native (package main, buildmode=c-shared)
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG1 (R1/R9/R11, RG1/RG2). Thin
// glue over golang.zx2c4.com/wireguard's device + tun/netstack packages —
// modeled closely on upstream's own tun/netstack/examples/http_server.go +
// http_client.go (see this package's header comments in server.go/
// testclient.go for exactly which pieces of that example each mirrors).
//
// Exported C API (scripts/build.mjs builds this with
// `go build -buildmode=c-shared`, loaded from Node via koffi —
// src/loader.ts):
//
//	WgStart(configJSON)              -> {ok,data:{instanceId}} | {ok:false,error}
//	WgStop(instanceId)                -> {ok:true} | {ok:false,error}
//	WgAddPeer(instanceId, peerJSON)    -> {ok:true} | {ok:false,error}
//	WgRemovePeer(instanceId, pubKey)   -> {ok:true} | {ok:false,error}
//	WgStatus(instanceId)               -> {ok,data:{listening,port,peers}} | error
//	WgTestClientFetch(clientConfigJSON, url) -> {ok,data:{status,bodyPrefix}} | error
//	WgFreeString(ptr)                  -> frees any string this library returned
//
// Every returned *C.char is heap-allocated via C.CString (C's malloc) —
// callers MUST pass it to WgFreeString exactly once (src/loader.ts does
// this for every call site; never call C's own free() from the host
// process, which may link a different CRT — see envelope.go's header).
//
// EVERY call from src/loader.ts MUST use koffi's `.async()` mode, never a
// synchronous call (koffi's default) — see testclient.go's WgTestClientFetch
// doc comment for the full empirical writeup: a synchronous koffi call
// blocking Node's calling thread for the duration of real network I/O was
// proven to starve this library's OWN background goroutines (wireguard-go's
// send/receive/encryption/decryption routines never got scheduled) until
// the call finally returned — a WG handshake would complete but no
// transport data would move. Routing every call through koffi's worker-
// thread async path fixed it completely and is now standing law for this
// package, not just WgTestClientFetch (which is merely where it was first
// caught) — WgStart/WgStop in particular spawn/tear down long-lived
// goroutines a synchronous call could equally starve.
//
// NO PACKET FORWARDING ANYWHERE (RG2): server.go's netstack owns exactly
// one address (the configured serverTunnelIp) and this file registers no
// route, proxy, or bridge to any other interface — see server.go's header
// for the full containment argument.
package main

func main() {}
