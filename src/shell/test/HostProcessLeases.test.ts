import { describe, expect, it, vi } from 'vitest';
import { Deferred } from '#src/shared/Deferred.js';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';

describe(HostProcessLeases, () => {
  it('rechecks a retargeted pending root and drops its reservation if the attaching window disconnects', async () => {
    const leases = new HostProcessLeases([]);
    const checked = new Deferred<void>();
    const inspected = new Deferred<void>();
    const cancelled = new Deferred<void>();
    const closed = new Deferred<void>();
    let physical = '/original';
    const check = async (proposed: readonly string[]) => {
      if (proposed.includes('/current')) throw new Error('Workspace now contains a helper');
      checked.resolve();
      await inspected.promise;
    };
    const process = leases.run(check, new AbortController().signal, signal => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled.resolve();
        },
        { once: true },
      );
      return closed.promise;
    });
    const ended = expect(process).rejects.toThrow('workspace is attaching');
    const admission = leases.admitWorkspace(
      () => [physical],
      () => {
        throw new Error('Disconnected');
      },
    );
    const disconnected = expect(admission).rejects.toThrow('Disconnected');
    await checked.promise;
    physical = '/current';
    expect(leases.workspaceRoots).toEqual(['/original', '/current']);
    inspected.resolve();
    await cancelled.promise;
    closed.resolve();
    await ended;
    await disconnected;
    expect(leases.workspaceRoots).toEqual([]);
    const publish = vi.fn();
    await leases.admitWorkspace(() => ['/current'], publish);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('admits a peer as soon as a failed child closes while native inspection finishes in the background', async () => {
    const leases = new HostProcessLeases([]);
    const proof = new Deferred<void>();
    const close = new Deferred<void>();
    const stopped = vi.fn();
    const child = leases.run(
      () => proof.promise,
      new AbortController().signal,
      signal => {
        signal.addEventListener('abort', stopped);
        return close.promise;
      },
    );
    const rejected = expect(child).rejects.toThrow('Launch failed');
    const publish = vi.fn();
    const admission = leases.admitWorkspace(() => ['/peer'], publish);
    close.reject(new Error('Launch failed'));
    await rejected;
    await admission;
    expect(publish).toHaveBeenCalledOnce();
    proof.reject(new Error('Former input overlapped'));
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
  });
});
