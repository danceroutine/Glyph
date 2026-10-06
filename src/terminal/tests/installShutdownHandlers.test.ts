import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ShutdownSignal } from '../ShutdownSignal.ts';
import { installShutdownHandlers } from '../installShutdownHandlers.ts';

describe(installShutdownHandlers, () => {
  it('cancels an active response before shutting down on SIGINT', () => {
    const source = new EventEmitter();
    const interrupt = new EventEmitter();
    const active = new AbortController();
    const signals: ShutdownSignal[] = [];
    const dispose = installShutdownHandlers(
      { active: () => active, interrupt, shutdown: signal => signals.push(signal) },
      source,
    );

    interrupt.emit(ShutdownSignal.SIGINT);
    expect(active.signal.aborted).toBe(true);
    expect(signals).toEqual([]);

    source.emit(ShutdownSignal.SIGINT);
    expect(signals).toEqual([ShutdownSignal.SIGINT]);
    dispose();
  });

  it('SIGTERM cancels active work and shuts down immediately', () => {
    const source = new EventEmitter();
    const active = new AbortController();
    const signals: ShutdownSignal[] = [];
    const dispose = installShutdownHandlers({ active: () => active, shutdown: signal => signals.push(signal) }, source);

    source.emit(ShutdownSignal.SIGTERM);
    expect(active.signal.aborted).toBe(true);
    expect(signals).toEqual([ShutdownSignal.SIGTERM]);
    dispose();
  });

  it('disposed shutdown handlers no longer receive signals', () => {
    const source = new EventEmitter();
    const signals: ShutdownSignal[] = [];
    const dispose = installShutdownHandlers(
      { active: () => undefined, shutdown: signal => signals.push(signal) },
      source,
    );

    dispose();
    source.emit(ShutdownSignal.SIGINT);
    source.emit(ShutdownSignal.SIGTERM);
    expect(signals).toEqual([]);
  });
});
