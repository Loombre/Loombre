// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/native/server.go
//
// The SERVER-side instance: one wireguard-go device terminating real OS UDP
// (conn.NewDefaultBind — RG1, no kernel module, no root, no TUN/TAP) bound
// to ONE virtual netstack address (RG2 containment). RG2/RG15's whole
// containment guarantee rests on THIS package never creating more than the
// ONE netstack TCP listener below, and never forwarding/proxying decrypted
// packets anywhere except the single loopback dial target
// (backendTcpPort): gVisor's stack.Options here carries no Forwarding
// option and this file adds no route beyond netstack.CreateNetTUN's own
// (which only ever points back at the lone virtual NIC) — a peer's packet
// addressed to anything but serverTunnelIp has nowhere to go and is
// dropped by the stack itself, never reaching a real interface. See
// tunnel_containment_test.go-equivalent coverage at the TS layer
// (packages/wg-native/test + apps/server's loopback/containment specs).
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type startConfig struct {
	PrivateKey     string       `json:"privateKey"`
	ListenPort     int          `json:"listenPort"`
	ServerTunnelIP string       `json:"serverTunnelIp"`
	Subnet         string       `json:"subnet"`
	Peers          []peerConfig `json:"peers"`
	BackendTCPPort int          `json:"backendTcpPort"`
}

type peerConfig struct {
	PublicKey string `json:"publicKey"`
	TunnelIP  string `json:"tunnelIp"`
}

type startResult struct {
	InstanceID string `json:"instanceId"`
}

type peerStatus struct {
	PublicKey       string `json:"publicKey"`
	TunnelIP        string `json:"tunnelIp,omitempty"`
	LastHandshakeMs int64  `json:"lastHandshakeMs"`
	RxBytes         int64  `json:"rxBytes"`
	TxBytes         int64  `json:"txBytes"`
}

type statusResult struct {
	Listening bool         `json:"listening"`
	Port      int          `json:"port"`
	Peers     []peerStatus `json:"peers"`
}

type serverInstance struct {
	mu             sync.Mutex
	dev            *device.Device
	tun            tun.Device
	tnet           *netstack.Net
	listener       net.Listener
	backendAddr    string
	serverTunnelIP string
	closed         bool
	acceptWG       sync.WaitGroup
	// peerTunnelIPs maps a peer's hex public key (the UAPI/IpcGet key
	// shape) to its tunnel IP for status reporting — wireguard-go's own
	// IpcGet output does not carry this application-level fact, only
	// allowed_ip entries (which ARE the tunnel IP for a /32 peer, but
	// parsing that back out is more fragile than tracking it directly at
	// AddPeer time).
	peerTunnelIPs map[string]string
}

var (
	instances  sync.Map // map[string]*serverInstance
	instanceMu sync.Mutex
)

func newInstanceID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate instance id: %w", err)
	}
	return "wg-" + hex.EncodeToString(buf), nil
}

func startServer(cfg startConfig) (*startResult, error) {
	if cfg.PrivateKey == "" {
		return nil, fmt.Errorf("privateKey is required")
	}
	if cfg.ServerTunnelIP == "" {
		return nil, fmt.Errorf("serverTunnelIp is required")
	}
	if cfg.BackendTCPPort <= 0 || cfg.BackendTCPPort > 65535 {
		return nil, fmt.Errorf("backendTcpPort must be a valid port, got %d", cfg.BackendTCPPort)
	}
	if cfg.ListenPort < 0 || cfg.ListenPort > 65535 {
		return nil, fmt.Errorf("listenPort must be between 0 and 65535, got %d", cfg.ListenPort)
	}

	privateKeyHex, err := base64KeyToHex(cfg.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("privateKey: %w", err)
	}

	serverAddr, err := netip.ParseAddr(cfg.ServerTunnelIP)
	if err != nil {
		return nil, fmt.Errorf("serverTunnelIp: %w", err)
	}

	if cfg.Subnet != "" {
		prefix, err := netip.ParsePrefix(cfg.Subnet)
		if err != nil {
			return nil, fmt.Errorf("subnet: %w", err)
		}
		if !prefix.Contains(serverAddr) {
			return nil, fmt.Errorf("serverTunnelIp %s is not within subnet %s", cfg.ServerTunnelIP, cfg.Subnet)
		}
	}

	peerTunnelIPs := make(map[string]string, len(cfg.Peers))
	var uapi string
	uapi += "private_key=" + privateKeyHex + "\n"
	uapi += fmt.Sprintf("listen_port=%d\n", cfg.ListenPort)
	for _, p := range cfg.Peers {
		peerHex, err := base64KeyToHex(p.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("peer publicKey: %w", err)
		}
		if p.TunnelIP == "" {
			return nil, fmt.Errorf("peer tunnelIp is required")
		}
		if _, err := netip.ParseAddr(p.TunnelIP); err != nil {
			return nil, fmt.Errorf("peer tunnelIp: %w", err)
		}
		uapi += "public_key=" + peerHex + "\n"
		uapi += "allowed_ip=" + p.TunnelIP + "/32\n"
		peerTunnelIPs[peerHex] = p.TunnelIP
	}

	// RG2: the ONLY local address this stack ever owns — no other NIC, no
	// forwarding option, so nothing else is reachable through it. No DNS
	// resolvers either: nothing inside this tunnel ever needs to resolve a
	// name (the client dials the server's tunnel IP directly).
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{serverAddr}, nil, device.DefaultMTU)
	if err != nil {
		return nil, fmt.Errorf("failed to create netstack TUN: %w", err)
	}

	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg-native(server): "))

	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, fmt.Errorf("failed to configure device: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("failed to bring device up: %w", err)
	}

	// netip.AddrPortFrom(serverAddr, ...) — NOT net.TCPAddr{IP: net.ParseIP(...)}.
	// net.ParseIP always returns a 16-byte slice (IPv4-mapped-in-IPv6 form)
	// even for a dotted-quad input, and netip.AddrFromSlice on that 16-byte
	// slice produces an Is4In6() address, a DIFFERENT internal
	// representation from the plain Is4() address netip.ParseAddr (used for
	// serverAddr above, and by the client's own dial resolution in
	// testclient.go) produces for the exact same dotted-quad string.
	// gVisor's connection table matched listener vs. incoming-SYN by exact
	// address representation, not looser IP equality — the mismatch caused
	// every inbound SYN to be silently dropped as "no listener", which is
	// EXACTLY what a first (real, verbose-logged) loopback-handshake dry
	// run against this file caught: the WG handshake itself completed
	// (crypto/key format proven WG-compatible) but the HTTP fetch through
	// the tunnel hung to timeout every time. Fixed by staying in netip the
	// whole way through, never round-tripping via net.IP/net.TCPAddr.
	listener, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(serverAddr, 80))
	if err != nil {
		dev.Close()
		return nil, fmt.Errorf("failed to listen on tunnel address: %w", err)
	}

	id, err := newInstanceID()
	if err != nil {
		listener.Close()
		dev.Close()
		return nil, err
	}

	inst := &serverInstance{
		dev:            dev,
		tun:            tunDev,
		tnet:           tnet,
		listener:       listener,
		backendAddr:    fmt.Sprintf("127.0.0.1:%d", cfg.BackendTCPPort),
		serverTunnelIP: cfg.ServerTunnelIP,
		peerTunnelIPs:  peerTunnelIPs,
	}
	instances.Store(id, inst)

	inst.acceptWG.Add(1)
	go inst.acceptLoop()

	return &startResult{InstanceID: id}, nil
}

// acceptLoop raw-pipes every accepted netstack connection to the loopback
// backend (RG2's "raw-TCP-pipes each accepted connection to a NEW
// loopback-only plain-HTTP backend listener" — zero HTTP-awareness, so
// HLS/websockets/query-token traffic is byte-transparent). Exits the moment
// Accept() errors, which is exactly what closing inst.listener causes.
func (inst *serverInstance) acceptLoop() {
	defer inst.acceptWG.Done()
	for {
		conn, err := inst.listener.Accept()
		if err != nil {
			return
		}
		go inst.pipeConnection(conn)
	}
}

func (inst *serverInstance) pipeConnection(client net.Conn) {
	defer client.Close()
	backend, err := net.Dial("tcp", inst.backendAddr)
	if err != nil {
		return
	}
	defer backend.Close()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(backend, client)
		if tc, ok := backend.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(client, backend)
		if tc, ok := client.(interface{ CloseWrite() error }); ok {
			_ = tc.CloseWrite()
		}
	}()
	wg.Wait()
}

func lookupInstance(id string) (*serverInstance, error) {
	v, ok := instances.Load(id)
	if !ok {
		return nil, fmt.Errorf("unknown wg-native instance id: %s", id)
	}
	return v.(*serverInstance), nil
}

func stopServer(id string) error {
	inst, err := lookupInstance(id)
	if err != nil {
		// WgStop is idempotent at the TS/service layer, but this library
		// itself just reports the honest fact — the caller (RemoteWireguardService)
		// is the one that decides "already stopped" is not an error.
		return err
	}

	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return nil
	}
	inst.closed = true
	inst.mu.Unlock()

	// Close the listener FIRST so acceptLoop stops accepting new
	// connections, then close the device — synchronous (device.Close()
	// blocks until its internal workers stop and the real UDP socket is
	// released, device/device.go), which is what lets a caller poll the
	// UDP port immediately after WgStop returns and reliably see it free.
	_ = inst.listener.Close()
	inst.dev.Close()
	inst.acceptWG.Wait()

	instances.Delete(id)
	return nil
}

func addPeer(id string, p peerConfig) error {
	inst, err := lookupInstance(id)
	if err != nil {
		return err
	}
	peerHex, err := base64KeyToHex(p.PublicKey)
	if err != nil {
		return fmt.Errorf("peer publicKey: %w", err)
	}
	if p.TunnelIP == "" {
		return fmt.Errorf("peer tunnelIp is required")
	}
	if _, err := netip.ParseAddr(p.TunnelIP); err != nil {
		return fmt.Errorf("peer tunnelIp: %w", err)
	}

	uapi := "public_key=" + peerHex + "\n" + "allowed_ip=" + p.TunnelIP + "/32\n"
	if err := inst.dev.IpcSet(uapi); err != nil {
		return fmt.Errorf("failed to add peer: %w", err)
	}

	inst.mu.Lock()
	inst.peerTunnelIPs[peerHex] = p.TunnelIP
	inst.mu.Unlock()
	return nil
}

func removePeer(id string, publicKeyBase64 string) error {
	inst, err := lookupInstance(id)
	if err != nil {
		return err
	}
	peerHex, err := base64KeyToHex(publicKeyBase64)
	if err != nil {
		return fmt.Errorf("publicKey: %w", err)
	}

	uapi := "public_key=" + peerHex + "\n" + "remove=true\n"
	if err := inst.dev.IpcSet(uapi); err != nil {
		return fmt.Errorf("failed to remove peer: %w", err)
	}

	inst.mu.Lock()
	delete(inst.peerTunnelIPs, peerHex)
	inst.mu.Unlock()
	return nil
}

func getStatus(id string) (*statusResult, error) {
	inst, err := lookupInstance(id)
	if err != nil {
		return nil, err
	}

	raw, err := inst.dev.IpcGet()
	if err != nil {
		return nil, fmt.Errorf("failed to read device state: %w", err)
	}

	parsed, err := parseUAPIStatus(raw)
	if err != nil {
		return nil, err
	}

	inst.mu.Lock()
	tunnelIPs := make(map[string]string, len(inst.peerTunnelIPs))
	for k, v := range inst.peerTunnelIPs {
		tunnelIPs[k] = v
	}
	inst.mu.Unlock()

	peers := make([]peerStatus, 0, len(parsed))
	for _, p := range parsed {
		b64, err := hexKeyToBase64(p.publicKeyHex)
		if err != nil {
			continue
		}
		peers = append(peers, peerStatus{
			PublicKey:       b64,
			TunnelIP:        tunnelIPs[p.publicKeyHex],
			LastHandshakeMs: p.lastHandshakeMs,
			RxBytes:         p.rxBytes,
			TxBytes:         p.txBytes,
		})
	}

	return &statusResult{Listening: true, Port: 0, Peers: peers}, nil
}

// bindPort reports the REAL bound UDP port straight from wireguard-go's own
// UAPI serialization (device.IpcGetOperation only emits listen_port when
// device.net.port != 0 — see device/uapi.go) rather than trusting back the
// caller-requested value, which matters when startConfig.ListenPort was 0
// (ephemeral — the loopback handshake test's own posture, R11 "unprivileged
// ports only").
func bindPort(id string) (int, error) {
	inst, err := lookupInstance(id)
	if err != nil {
		return 0, err
	}
	raw, err := inst.dev.IpcGet()
	if err != nil {
		return 0, fmt.Errorf("failed to read device state: %w", err)
	}
	return parseListenPort(raw)
}

// -- cgo exports -------------------------------------------------------

//export WgStart
func WgStart(configJSON *C.char) *C.char {
	var cfg startConfig
	if err := json.Unmarshal([]byte(C.GoString(configJSON)), &cfg); err != nil {
		return respondErr(fmt.Errorf("invalid config JSON: %w", err))
	}
	instanceMu.Lock()
	defer instanceMu.Unlock()
	result, err := startServer(cfg)
	if err != nil {
		return respondErr(err)
	}
	return respondOK(result)
}

//export WgStop
func WgStop(instanceID *C.char) *C.char {
	id := C.GoString(instanceID)
	instanceMu.Lock()
	defer instanceMu.Unlock()
	if err := stopServer(id); err != nil {
		return respondErr(err)
	}
	return respondOK(struct{}{})
}

//export WgAddPeer
func WgAddPeer(instanceID *C.char, peerJSON *C.char) *C.char {
	var p peerConfig
	if err := json.Unmarshal([]byte(C.GoString(peerJSON)), &p); err != nil {
		return respondErr(fmt.Errorf("invalid peer JSON: %w", err))
	}
	if err := addPeer(C.GoString(instanceID), p); err != nil {
		return respondErr(err)
	}
	return respondOK(struct{}{})
}

//export WgRemovePeer
func WgRemovePeer(instanceID *C.char, publicKeyBase64 *C.char) *C.char {
	if err := removePeer(C.GoString(instanceID), C.GoString(publicKeyBase64)); err != nil {
		return respondErr(err)
	}
	return respondOK(struct{}{})
}

//export WgStatus
func WgStatus(instanceID *C.char) *C.char {
	id := C.GoString(instanceID)
	status, err := getStatus(id)
	if err != nil {
		return respondErr(err)
	}
	port, err := bindPort(id)
	if err != nil {
		return respondErr(err)
	}
	status.Port = port
	return respondOK(status)
}
