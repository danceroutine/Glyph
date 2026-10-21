import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import { ChatOperationSerializer } from '#src/desktop/host/ChatOperationSerializer.js';
import { HostEventJournal } from '#src/desktop/host/HostEventJournal.js';
import { RequestDeduplicator } from '#src/desktop/host/RequestDeduplicator.js';
import {
  getWorkspaceKey,
  WorkspaceOwnershipErrorCode,
  WorkspaceOwnershipRegistry,
} from '#src/desktop/host/WorkspaceOwnershipRegistry.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';

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

  describe(WorkspaceOwnershipRegistry.prototype.acquire, () => {
    it('requires at least one workspace root', () => {
      const registry = new WorkspaceOwnershipRegistry();
      expect(() => registry.acquire(first, [])).toThrow(
        expect.objectContaining({
          name: 'WorkspaceOwnershipError',
          code: WorkspaceOwnershipErrorCode.EMPTY_WORKSPACE,
          message: 'A desktop workspace requires at least one local root.',
        }),
      );
    });

    it('refuses changed roots for an already owned workspace', () => {
      const registry = new WorkspaceOwnershipRegistry();
      registry.acquire(first, [{ name: 'a', uri: 'file:///glyph-a', canonicalPath: '/glyph-a' }]);
      expect(() => registry.acquire(first, [{ name: 'b', uri: 'file:///glyph-b', canonicalPath: '/glyph-b' }])).toThrow(
        expect.objectContaining({
          code: WorkspaceOwnershipErrorCode.ROOTS_CHANGED,
          message: 'Workspace roots changed without detaching the existing owner.',
        }),
      );
    });

    it('refuses a parent folder of an owned workspace', () => {
      const registry = new WorkspaceOwnershipRegistry();
      registry.acquire(first, [{ name: 'nested', uri: 'file:///glyph/nested', canonicalPath: '/glyph/nested' }]);
      expect(() =>
        registry.acquire({ ...second, workspaceId: 'parent' }, [
          { name: 'parent', uri: 'file:///glyph', canonicalPath: '/glyph' },
        ]),
      ).toThrow(expect.objectContaining({ code: WorkspaceOwnershipErrorCode.ROOTS_OVERLAP }));
    });

    it('grants the owner again for the same roots listed in another order', () => {
      const registry = new WorkspaceOwnershipRegistry();
      const a = { name: 'a', uri: 'file:///glyph-a', canonicalPath: '/glyph-a' };
      const b = { name: 'b', uri: 'file:///glyph-b', canonicalPath: '/glyph-b' };
      registry.acquire(first, [a, b]);
      expect(registry.acquire(first, [b, a])).toEqual({ ownerWindowId: 'one', readOnly: false });
    });

    it('reserves a missing root through its real existing ancestor', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-ownership-missing-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const registry = new WorkspaceOwnershipRegistry();
      const missing = join(directory, 'missing', 'project');
      registry.acquire(first, [{ name: 'missing', uri: pathToFileURL(missing).toString(), canonicalPath: missing }]);
      const real = join(await realpath(directory), 'missing');
      expect(() =>
        registry.acquire({ ...second, workspaceId: 'real' }, [
          { name: 'real', uri: pathToFileURL(real).toString(), canonicalPath: real },
        ]),
      ).toThrow(expect.objectContaining({ code: WorkspaceOwnershipErrorCode.ROOTS_OVERLAP }));
    });

    it('surfaces filesystem failures other than a missing path', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-ownership-file-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const file = join(directory, 'file.txt');
      await writeFile(file, 'not a directory');
      const registry = new WorkspaceOwnershipRegistry();
      const nested = join(file, 'project');
      expect(() =>
        registry.acquire(first, [{ name: 'nested', uri: pathToFileURL(nested).toString(), canonicalPath: nested }]),
      ).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    });
  });

  describe(WorkspaceOwnershipRegistry.prototype.getOwnerWindowId, () => {
    it('reports the owning window until it releases the workspace', () => {
      const registry = new WorkspaceOwnershipRegistry();
      expect(registry.getOwnerWindowId(first)).toBeUndefined();
      registry.acquire(first, roots);
      expect(registry.getOwnerWindowId({ profileId: 'profile', workspaceId: 'workspace' })).toBe('one');
      registry.release(first);
      expect(registry.getOwnerWindowId(first)).toBeUndefined();
    });
  });
});

describe(getWorkspaceKey, () => {
  it('distinguishes profiles and workspaces with a separator that cannot appear in either', () => {
    expect(getWorkspaceKey({ profileId: 'a', workspaceId: 'b' })).toBe('a\0b');
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

  it.each([0, -1, 1.5, Number.NaN])('rejects a capacity of %s', capacity => {
    expect(() => new HostEventJournal('generation', capacity)).toThrow('Event journal capacity must be positive.');
  });

  describe(HostEventJournal.prototype.after, () => {
    it('reports a gap for any sequence before the first event is issued', () => {
      const journal = new HostEventJournal('generation');
      expect(journal.after(0)).toEqual([]);
      expect(journal.after(5)).toBeUndefined();
      expect(journal.after(-1)).toBeUndefined();
    });
  });

  describe(HostEventJournal.prototype.append, () => {
    it('stamps events with the identity, protocol version, generation, and sequence', () => {
      const journal = new HostEventJournal('generation');
      const event = { type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY } as const;
      expect(journal.append(first, event)).toEqual({
        ...first,
        protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
        hostGeneration: 'generation',
        sequence: 1,
        event,
      });
    });
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

  describe(ChatOperationSerializer.prototype.run, () => {
    it('continues with the next operation after one fails', async () => {
      const serializer = new ChatOperationSerializer();
      const failed = serializer.run('chat', 'one', async () => {
        throw new Error('Turn failed');
      });
      const next = serializer.run('chat', 'one', async () => 'next');
      await expect(failed).rejects.toThrow('Turn failed');
      await expect(next).resolves.toBe('next');
    });
  });

  describe(ChatOperationSerializer.prototype.releaseWindow, () => {
    it('keeps chats owned by other windows', async () => {
      const serializer = new ChatOperationSerializer();
      await serializer.run('chat', 'one', async () => {});
      await serializer.run('other', 'two', async () => {});
      serializer.releaseWindow('one');
      await expect(serializer.run('other', 'three', async () => {})).rejects.toThrow(
        'Chat other is active in window two.',
      );
      await expect(serializer.run('chat', 'three', async () => 'claimed')).resolves.toBe('claimed');
    });
  });
});
