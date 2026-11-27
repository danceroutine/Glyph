import { describe, it, expect, vi } from 'vitest';
import { NativePinnedSourceAuthority } from '../PinnedSourceAuthority.ts';
import { WorkspaceAccessPolicy } from '../policy/WorkspaceAccessPolicy.ts';

describe(NativePinnedSourceAuthority, () => {
  it('batches captured sources and accepts a saved revision only at the original authorized location', async () => {
    let origin = 'route';
    let identity = '1:2';
    let trusted = true;
    const sourceOrigins = vi.fn(async (paths: readonly string[]) => paths.map(() => ({ origin, identity })));
    let privatePaths = ['/state'];
    const policy = new WorkspaceAccessPolicy({}, () => privatePaths);
    const authority = new NativePinnedSourceAuthority({ sourceOrigins }, policy, () => {
      if (!trusted) throw new Error('untrusted');
    });
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
});
