// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { LineRingBuffer } from "./line-ring-buffer.js";

describe("LineRingBuffer — line splitting", () => {
  it("splits a single chunk containing multiple complete lines", () => {
    const buf = new LineRingBuffer();
    buf.push("line1\nline2\nline3\n");
    expect(buf.tail(10)).toEqual(["line1", "line2", "line3"]);
  });

  it("buffers a trailing partial line until the next chunk completes it", () => {
    const buf = new LineRingBuffer();
    buf.push("hello wo");
    expect(buf.tail(10)).toEqual([]);
    buf.push("rld\n");
    expect(buf.tail(10)).toEqual(["hello world"]);
  });

  it("handles CRLF line endings", () => {
    const buf = new LineRingBuffer();
    buf.push("a\r\nb\r\n");
    expect(buf.tail(10)).toEqual(["a", "b"]);
  });

  it("calls onLine synchronously for each complete line, not for the trailing partial", () => {
    const buf = new LineRingBuffer();
    const seen: string[] = [];
    buf.push("one\ntwo\nthree-partial", (line) => seen.push(line));
    expect(seen).toEqual(["one", "two"]);
  });
});

describe("LineRingBuffer — bounded history", () => {
  it("caps at 1000 lines, dropping the oldest", () => {
    const buf = new LineRingBuffer();
    for (let i = 0; i < 1200; i++) buf.push(`line${i}\n`);
    const all = buf.tail(2000);
    expect(all.length).toBe(1000);
    expect(all[0]).toBe("line200");
    expect(all[all.length - 1]).toBe("line1199");
  });
});

describe("LineRingBuffer — tail()", () => {
  it("returns newest-last, bounded to limit", () => {
    const buf = new LineRingBuffer();
    for (let i = 0; i < 5; i++) buf.push(`line${i}\n`);
    expect(buf.tail(2)).toEqual(["line3", "line4"]);
  });

  it("returns everything when limit exceeds history", () => {
    const buf = new LineRingBuffer();
    buf.push("a\nb\n");
    expect(buf.tail(500)).toEqual(["a", "b"]);
  });

  it("returns an empty array for a non-positive limit", () => {
    const buf = new LineRingBuffer();
    buf.push("a\n");
    expect(buf.tail(0)).toEqual([]);
    expect(buf.tail(-5)).toEqual([]);
  });
});
