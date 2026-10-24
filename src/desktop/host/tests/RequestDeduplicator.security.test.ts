import { describe, expect, it, vi } from 'vitest';
import { RequestDeduplicator } from '#src/desktop/host/RequestDeduplicator.js';

describe('security: renderer request admission', () => {
  /**
   * A registered renderer can retry a pending side effect after submitting enough
   * unrelated IDs to churn the result cache. Capacity must never discard the
   * pending operation's identity. This fixture holds one operation behind a
   * promise and records dispatch, without performing any real side effect.
   * Excess work may reject, but retrying the original ID must share its result.
   */
  it('retains a pending request through capacity churn and rejects excess admission', async () => {
    const requests = new RequestDeduplicator<number>(1);
    let complete!: (value: number) => void;
    const operation = vi.fn(
      () =>
        new Promise<number>(resolve => {
          complete = resolve;
        }),
    );
    const first = requests.run('pending', operation);
    const excess = vi.fn(async () => 2);
    try {
      await expect(Promise.resolve().then(() => requests.run('excess', excess))).rejects.toThrow(/capacity/iu);
      expect(excess).not.toHaveBeenCalled();
      expect(requests.run('pending', operation)).toBe(first);
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      complete(1);
      await first;
    }
    await expect(requests.run('excess', excess)).resolves.toBe(2);
    expect(excess).toHaveBeenCalledOnce();
  });

  /**
   * A failed request can already have produced effects. Its rejection must be
   * shared just like success until ordinary completed-result eviction, and its
   * settlement must release admission capacity. No global exactly-once promise
   * is inferred after completed entries expire.
   */
  it('shares rejected results and admits new work after settlement', async () => {
    const requests = new RequestDeduplicator<number>(1);
    const failure = new Error('fixture operation failed after admission');
    const operation = vi.fn(async () => {
      throw failure;
    });
    const first = requests.run('failed', operation);
    await expect(first).rejects.toBe(failure);
    expect(requests.run('failed', operation)).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
    await expect(requests.run('next', async () => 3)).resolves.toBe(3);
  });

  /**
   * Operation code can synchronously reenter the host or throw before returning
   * its promise. Identity must be reserved before invocation, otherwise reentry
   * dispatches twice. A synchronous throw must settle the reserved result.
   */
  it('reserves identity before invoking reentrant or synchronously throwing operations', async () => {
    const requests = new RequestDeduplicator<number>(1);
    const duplicate = vi.fn(async () => 99);
    let reentrant: Promise<number> | undefined;
    const first = requests.run('same', async () => {
      reentrant = requests.run('same', duplicate);
      return 7;
    });
    await expect(first).resolves.toBe(7);
    expect(reentrant).toBe(first);
    expect(duplicate).not.toHaveBeenCalled();
    const failure = new Error('synchronous fixture failure');
    const throwing = vi.fn(() => {
      throw failure;
    });
    await expect(requests.run('throws', throwing)).rejects.toBe(failure);
    await expect(requests.run('throws', throwing)).rejects.toBe(failure);
    expect(throwing).toHaveBeenCalledOnce();
  });
});
