// src/server/debouncer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Debouncer } from './debouncer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Debouncer', () => {
  it('runs the function once after the delay', () => {
    const fn = vi.fn();
    const d = new Debouncer(1000);
    d.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid schedules into a single trailing call', () => {
    const fn = vi.fn();
    const d = new Debouncer(1000);
    d.schedule(fn);
    vi.advanceTimersByTime(500);
    d.schedule(fn);
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() runs the pending function immediately and cancels the timer', () => {
    const fn = vi.fn();
    const d = new Debouncer(1000);
    d.schedule(fn);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops the pending function', () => {
    const fn = vi.fn();
    const d = new Debouncer(1000);
    d.schedule(fn);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
