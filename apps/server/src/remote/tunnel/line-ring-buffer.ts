// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/line-ring-buffer.ts
//
// STATE.md RG7 (T2): bounded stdout+stderr tail backing ConnectorManager.
// logsTail() — apps/worker/src/transcode/process.ts's "4KB ring buffer"
// precedent is BYTE-bounded because ffmpeg's stderr tail is read as one
// opaque diagnostic string; logsTail(limit) is LINE-bounded instead
// (packages/contract/openapi.yaml's `lines` query param, 1-500) because an
// admin reads it as a log viewer, not a single string — so this buffer
// caps by LINE COUNT, generously above the contract's own 500-line
// ceiling so a request for the max never truncates against this buffer's
// own cap rather than genuine history.

const MAX_LINES = 1000;

export class LineRingBuffer {
  private lines: string[] = [];
  private partial = "";

  /**
   * Feeds a raw stdout/stderr chunk — splits on newlines, buffering any
   * trailing partial line until the next chunk completes it (a chunk
   * boundary rarely lands exactly on a newline). `onLine`, when given, is
   * called synchronously for every COMPLETE line as it lands — the caller
   * (cloudflared-connector-manager.ts) uses this to classify readiness/
   * connection-lost signals the instant a line completes, not on some
   * later read.
   */
  push(chunk: string, onLine?: (line: string) => void): void {
    const combined = this.partial + chunk;
    const parts = combined.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      onLine?.(line);
    }
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }
  }

  /** Newest-last tail, bounded to `limit` — GET /admin/remote/tunnel/logs'
   *  own 1-500 clamp lives in the controller; this just slices. */
  tail(limit: number): string[] {
    if (limit <= 0) return [];
    return this.lines.slice(-limit);
  }
}
