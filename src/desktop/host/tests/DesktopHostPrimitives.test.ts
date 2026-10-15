import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import { ChatOperationSerializer } from '#src/desktop/host/ChatOperationSerializer.js';
import { HostEventJournal } from '#src/desktop/host/HostEventJournal.js';
import { RequestDeduplicator } from '#src/desktop/host/RequestDeduplicator.js';
import { WorkspaceOwnershipRegistry } from '#src/desktop/host/WorkspaceOwnershipRegistry.js';

const first = { profileId: 'profile', windowId: 'one', workspaceId: 'workspace' } as const;
const second = { ...first, windowId: 'two' } as const;
const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }] as const;

describe(WorkspaceOwnershipRegistry, () => {
  it('refuses a second mutation owner for the same directory reached through another symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-ownership-alias-'));
    try {
      const target = join(root, 'target');
      await mkdir(target);
      const aliases = [join(root, 'first-alias'), join(root, 'second-alias')];
      for (const alias of aliases) await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect(await realpath(aliases[0]!)).toBe(await realpath(aliases[1]!));
      const registry = new WorkspaceOwnershipRegistry();
      const workspaceRoots = (path: string) => [
        { name: 'project', uri: pathToFileURL(path).toString(), canonicalPath: path },
      ];
      expect(registry.acquire(first, workspaceRoots(aliases[0]!)).readOnly).toBe(false);
      expect(() =>
        registry.acquire({ ...second, workspaceId: 'alias-workspace' }, workspaceRoots(aliases[1]!)),
      ).toThrow(/overlap/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('grants one owner, permits a read-only peer, and blocks overlapping workspaces across profiles', () => {
    const registry = new WorkspaceOwnershipRegistry();
    expect(registry.acquire(first, roots)).toEqual({ ownerWindowId: 'one', readOnly: false });
    expect(registry.acquire(second, roots)).toEqual({
      ownerWindowId: 'one',
      readOnly: true,
      focusOwnerWindowId: 'one',
    });
    expect(() =>
      registry.acquire({ profileId: 'other', windowId: 'three', workspaceId: 'other' }, [
        { name: 'nested', uri: 'file:///project/src', canonicalPath: '/project/src' },
      ]),
    ).toThrowError(/overlap/);
    expect(registry.release(second)).toBe(false);
    expect(registry.release(first)).toBe(true);
  });
});

describe(HostEventJournal, () => {
  it('maintains a bounded sequence watermark and reports replay gaps', () => {
    const journal = new HostEventJournal('generation', 2);
    journal.append(first, { type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY });
    journal.append(first, { type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.RECONNECTING });
    journal.append(first, { type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.DISCONNECTED });
    expect(journal.watermark).toBe(3);
    expect(journal.after(1)?.map(event => event.sequence)).toEqual([2, 3]);
    expect(journal.after(0)).toBeUndefined();
    expect(journal.after(3)).toEqual([]);
  });
});

describe(RequestDeduplicator, () => {
  it('shares in-flight and completed command results within a bounded cache', async () => {
    const deduplicator = new RequestDeduplicator<number>(1);
    const operation = vi.fn(async () => 1);
    expect(await Promise.all([deduplicator.run('one', operation), deduplicator.run('one', operation)])).toEqual([1, 1]);
    expect(operation).toHaveBeenCalledTimes(1);
    await deduplicator.run('two', async () => 2);
    await deduplicator.run('one', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid capacities', () => {
    expect(() => new RequestDeduplicator(0)).toThrowError(/positive/);
  });
});

describe(ChatOperationSerializer, () => {
  it('orders one chat and rejects a competing window owner', async () => {
    const serializer = new ChatOperationSerializer();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const firstOperation = serializer.run('chat', 'one', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const secondOperation = serializer.run('chat', 'one', async () => order.push('second'));
    await expect(serializer.run('chat', 'two', async () => {})).rejects.toThrowError(/window one/);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    serializer.releaseWindow('one');
    await expect(serializer.run('chat', 'two', async () => 'ok')).resolves.toBe('ok');
  });
});
