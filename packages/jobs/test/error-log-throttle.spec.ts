// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createErrorLogThrottle } from '../src/error-log-throttle.js';

describe('createErrorLogThrottle', () => {
  it('logs the first occurrence in full', () => {
    const throttle = createErrorLogThrottle({ windowMs: 1000 });
    expect(throttle.record(new Error('terminating connection due to administrator command'), 0)).toBe(
      'Error: terminating connection due to administrator command',
    );
  });

  it('suppresses identical repeats inside the window and reports the count when the window elapses', () => {
    const throttle = createErrorLogThrottle({ windowMs: 1000 });
    const err = new Error('boom');
    expect(throttle.record(err, 0)).not.toBeNull();
    expect(throttle.record(err, 200)).toBeNull();
    expect(throttle.record(err, 400)).toBeNull();
    expect(throttle.record(err, 600)).toBeNull();
    expect(throttle.record(err, 1000)).toBe('(previous error repeated 3 more times) Error: boom');
    // A fresh window starts at the report.
    expect(throttle.record(err, 1100)).toBeNull();
  });

  it('a different message breaks the streak immediately and carries the suppressed count', () => {
    const throttle = createErrorLogThrottle({ windowMs: 60_000 });
    expect(throttle.record(new Error('a'), 0)).toBe('Error: a');
    expect(throttle.record(new Error('a'), 10)).toBeNull();
    expect(throttle.record(new Error('b'), 20)).toBe('(previous error repeated 1 more time) Error: b');
    expect(throttle.record(new Error('a'), 30)).toBe('Error: a');
  });

  it('renders non-Error values as strings', () => {
    const throttle = createErrorLogThrottle();
    expect(throttle.record('plain string', 0)).toBe('plain string');
    expect(throttle.record({ toString: () => 'custom' }, 1)).toBe('custom');
  });
});
