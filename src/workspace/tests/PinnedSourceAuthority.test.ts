import { describe, it, expect, vi } from 'vitest';
import { NativePinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';

describe(NativePinnedSourceAuthority, () => {
  it('batches captured sources and accepts a saved revision only at the original authorized location', async () => {
    let origin = 'route';
    let identity = '1:2';
    let trusted = true;
    const sourceOrigins = vi.fn(async (paths: readonly string[]) => paths.map(() => ({ origin, identity })));
    let privatePaths = ['/state'];
    const policy = new WorkspaceAccessPolicy({}, () => privatePaths);
    const authority = new NativePinnedSourceAuthority(
      { sourceOrigins, availableSourceOrigins: vi.fn() },
      policy,
      () => {
        if (!trusted) throw new Error('untrusted');
      },
    );
    const paths = ['/project/a', '/project/b'];
    const pins = await authority.capture(paths);
    expect(pins[1]).toEqual({ path: paths[1], origin, identity });
    expect(sourceOrigins).toHaveBeenCalledExactlyOnceWith(paths, privatePaths, undefined);
    identity = '1:3';
    const handoff = await authority.authorize(pins);
    handoff();
    trusted = false;
    expect(handoff).toThrow('untrusted');
    trusted = true;
    privatePaths = ['/state', '/new'];
    expect(handoff).toThrow('access changed');
    origin = 'replaced';
    await expect(authority.authorize(pins)).rejects.toThrow('location changed');
    sourceOrigins.mockResolvedValueOnce([]);
    await expect(authority.capture(paths)).rejects.toThrow('Incomplete');
  });
  it('withholds a cancelled batch or a response whose reservations changed during native inspection', async () => {
    let paths: string[] = [];
    const stop = new AbortController();
    const authority = new NativePinnedSourceAuthority(
      {
        availableSourceOrigins: vi.fn(),
        sourceOrigins: async () => {
          paths = ['/profile'];
          return [];
        },
      },
      new WorkspaceAccessPolicy({}, () => paths),
      () => {},
    );
    await expect(authority.capture(['/selected'], stop.signal)).rejects.toThrow('access changed');
    stop.abort(new Error('cancelled'));
    await expect(authority.capture([], stop.signal)).rejects.toThrow('cancelled');
  });
  it('keeps siblings from current attachments when another route is unavailable before or during enrollment', async () => {
    const good = vi.fn();
    const missing = vi.fn(() => {
      throw new Error('Detached');
    });
    const changing = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('Retargeted');
      });
    const availableSourceOrigins = vi.fn(async (selected: readonly string[]) =>
      selected.map(path => ({ origin: path, identity: '1:2' })),
    );
    const sourceOrigins = vi.fn();
    const roots = new Map([
      ['good', good],
      ['missing', missing],
      ['changing', changing],
    ]);
    const authority = new NativePinnedSourceAuthority(
      { availableSourceOrigins, sourceOrigins },
      new WorkspaceAccessPolicy(),
      () => {},
      path => {
        if (path === 'outside') throw new Error('Outside workspace');
        return { path: '/selected/' + path, assertCurrent: roots.get(path.split('/')[0]!)! };
      },
    );
    const paths = ['outside', 'missing/a', 'good/a', 'changing/a', 'good/b'];
    const pins = await authority.capture(paths, undefined, 'available');
    expect(availableSourceOrigins).toHaveBeenCalledExactlyOnceWith(
      ['/selected/good/a', '/selected/changing/a', '/selected/good/b'],
      [],
      undefined,
    );
    expect(pins.map(pin => pin?.path)).toEqual([undefined, undefined, 'good/a', undefined, 'good/b']);
    expect(good).toHaveBeenCalledTimes(2);
    await expect(authority.capture(['outside'])).rejects.toThrow('Outside workspace');
    await expect(authority.capture(['missing/a'])).rejects.toThrow('Detached');
    expect(sourceOrigins).not.toHaveBeenCalled();
  });
});
