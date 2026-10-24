import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileApprovalStore } from '#src/interaction/approvals/FileApprovalStore.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type { ApprovalGrant } from '#src/interaction/approvals/ApprovalGrant.js';
import type { WorkspaceScope } from '#src/interaction/approvals/ApprovalRequest.js';

const scope: WorkspaceScope = { workspaceId: 'workspace', mutationScope: 'canonical-workspace' };
const grant: ApprovalGrant = {
  id: 'grant',
  workspace: scope,
  permission: { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' },
  originatingDecisionId: 'decision',
  createdAt: '2026-10-23',
};
async function save(store: FileApprovalStore) {
  const snapshot = await store.load(scope);
  return store.save(scope, snapshot.revision, [grant]);
}
async function allows(store: FileApprovalStore, requested = scope) {
  return (await store.load(requested)).grants.some(
    stored =>
      stored.workspace.workspaceId === requested.workspaceId &&
      stored.workspace.mutationScope === requested.mutationScope,
  );
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'glyph-approval-security-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state');
  const path = join(directory, 'approval-grants.json');
  return { root, directory, path, store: new FileApprovalStore(directory) };
}

describe('security: persisted internal web consent', () => {
  /**
   * A remembered broad grant is private state bound to the canonical workspace
   * identity. Reopening the store may reuse it only for that identity. Neither
   * this file nor its schema can turn a shell grant into web authority.
   */
  it('persists a private workspace grant and ignores it after roots change', async () => {
    const f = await fixture();
    expect(await allows(f.store)).toBe(false);
    await save(f.store);
    expect(await allows(new FileApprovalStore(f.directory))).toBe(true);
    expect(await allows(f.store, { ...scope, mutationScope: 'different-roots' })).toBe(false);
    expect((await fs.stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(f.directory)).toEqual(['approval-grants.json']);
  });

  /**
   * Imported or locally substituted consent must not acquire authority merely
   * by following an alias or parsing an oversized/nonregular object. All targets
   * belong to this disposable fixture; sentinel bytes and permissions are intact.
   * Parent-directory trust is still an OS/private-state assumption.
   */
  it.each(['symlink', 'hardlink', 'directory', 'oversized', 'malformed', 'wrong capability'] as const)(
    'rejects %s consent state without changing its target',
    async kind => {
      const f = await fixture();
      await save(f.store);
      const target = join(f.root, 'sentinel');
      const before = await fs.readFile(f.path);
      await fs.rename(f.path, target);
      const mode = (await fs.stat(target)).mode;
      switch (kind) {
        case 'symlink':
          await fs.symlink(target, f.path);
          break;
        case 'hardlink':
          await fs.link(target, f.path);
          break;
        case 'directory':
          await fs.mkdir(f.path);
          break;
        case 'oversized':
          await fs.writeFile(f.path, 'x'.repeat(65_537));
          break;
        case 'malformed':
          await fs.writeFile(f.path, '{');
          break;
        case 'wrong capability':
          await fs.writeFile(
            f.path,
            JSON.stringify({
              schemaVersion: 1,
              workspaceId: scope.workspaceId,
              capability: 'shell',
              allowEverything: true,
            }),
          );
          break;
      }
      await expect(allows(f.store)).rejects.toThrow();
      expect(await fs.readFile(target)).toEqual(before);
      expect((await fs.stat(target)).mode).toBe(mode);
    },
  );

  /**
   * A file can grow after stat. The opened descriptor may yield at most the
   * fixed budget plus one sentinel byte; never allocate from a declared size.
   * The injected handle models growth and records closure without a large file.
   */
  it('bounds reads of a growing file and closes its descriptor on rejection', async () => {
    const f = await fixture();
    const handle = {
      stat: vi.fn(async () => ({ isFile: () => true, nlink: 1, size: 1 })),
      read: vi.fn(async (_buffer: Buffer, _offset: number, length: number) => ({ bytesRead: length })),
      close: vi.fn(async () => {}),
    };
    const open = vi.fn(async () => handle) as unknown as typeof fs.open;
    const store = new FileApprovalStore(f.directory, { ...fs, open });
    await expect(store.load(scope)).rejects.toThrow('size limit');
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.read.mock.calls[0]![0].length).toBe(65_537);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  /**
   * Failure before atomic replacement cannot install a remembered permission.
   * Owned temporary files are removed after failed writes/rename; an exclusive
   * creation collision does not authorize cleanup of someone else's file.
   */
  it.each(['write', 'rename', 'open'] as const)('does not install a grant after %s failure', async phase => {
    const f = await fixture();
    const failure = new Error('fixture persistence failure');
    const open: typeof fs.open = async (...args) => {
      if (phase === 'open') throw failure;
      const handle = await fs.open(...args);
      if (phase === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
      return handle;
    };
    const rename = phase === 'rename' ? vi.fn<typeof fs.rename>().mockRejectedValueOnce(failure) : fs.rename;
    const unlink = vi.fn(fs.unlink);
    const store = new FileApprovalStore(f.directory, { ...fs, open, rename, unlink });
    await expect(store.save(scope, (await f.store.load(scope)).revision, [grant])).rejects.toBe(failure);
    expect(await fs.readdir(f.directory)).toEqual([]);
    if (phase === 'open') expect(unlink).not.toHaveBeenCalled();
    expect(await allows(f.store)).toBe(false);
  });

  /** Cleanup errors remain visible; they are not converted into permission success. */
  it('reports cleanup failure and leaves no silently admitted grant after failed replacement', async () => {
    const f = await fixture();
    const store = new FileApprovalStore(f.directory, {
      ...fs,
      rename: vi.fn<typeof fs.rename>().mockRejectedValue(new Error('rename failed')),
      unlink: vi.fn<typeof fs.unlink>().mockRejectedValue(new Error('cleanup failed')),
    });
    await expect(store.save(scope, (await f.store.load(scope)).revision, [grant])).rejects.toThrow('cleanup failed');
    expect(await allows(f.store)).toBe(false);
  });
});

/** Migration keeps exact commands directory-bound; old unscoped strings cannot acquire new authority. */
it.each([1, 2])(
  'imports legacy shell version %s and web grants without rewriting the originals',
  async schemaVersion => {
    const f = await fixture();
    await fs.mkdir(f.directory);
    const shell = JSON.stringify({
      schemaVersion,
      projectContextId: scope.mutationScope,
      mode: 'allow_safe',
      allowedCommands: schemaVersion === 1 ? ['pwd'] : [{ command: 'pwd', workingDirectory: '/repo' }],
    });
    const web = JSON.stringify({
      schemaVersion: 1,
      workspaceId: scope.mutationScope,
      capability: 'internal_web',
      allowEverything: true,
    });
    await fs.writeFile(join(f.directory, 'shell-permissions.json'), shell);
    await fs.writeFile(join(f.directory, 'internal-web-approvals.json'), web);
    const imported = await f.store.load(scope);
    expect(imported.grants.map(stored => stored.permission.kind)).toEqual(
      schemaVersion === 1
        ? ['safe_inspection', 'all_internal_web']
        : ['exact_command', 'safe_inspection', 'all_internal_web'],
    );
    expect((await f.store.load({ ...scope, mutationScope: 'changed' })).grants).toEqual([]);
    await f.store.save(scope, imported.revision, imported.grants);
    expect(await fs.readFile(join(f.directory, 'shell-permissions.json'), 'utf8')).toBe(shell);
    expect(await fs.readFile(join(f.directory, 'internal-web-approvals.json'), 'utf8')).toBe(web);
    expect((await f.store.load(scope)).grants).toEqual(imported.grants);
  },
);

/** Full shell permission stays a shell permission; an ask policy with no commands grants nothing. */
it.each(['ask', 'allow_everything'])('imports legacy shell %s without broadening web consent', async mode => {
  const f = await fixture();
  await fs.mkdir(f.directory);
  await fs.writeFile(
    join(f.directory, 'shell-permissions.json'),
    JSON.stringify({ schemaVersion: 2, projectContextId: scope.mutationScope, mode, allowedCommands: [] }),
  );
  expect((await f.store.load(scope)).grants.map(stored => stored.permission)).toEqual(
    mode === 'ask' ? [] : [{ capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' }],
  );
});

/** Stale writers must never overwrite another capability's newly saved consent or recreate a revoked grant. */
it('rejects stale revisions and never steals an existing update lock', async () => {
  const f = await fixture();
  const empty = await f.store.load(scope);
  const saved = await f.store.save(scope, empty.revision, [grant]);
  await expect(new FileApprovalStore(f.directory).save(scope, empty.revision, [])).rejects.toThrow('changed');
  expect(await f.store.load(scope)).toEqual(saved);
  await fs.writeFile(`${f.path}.lock`, 'another writer');
  await expect(f.store.save(scope, saved.revision, [])).rejects.toThrow();
  expect(await fs.readFile(`${f.path}.lock`, 'utf8')).toBe('another writer');
  await fs.unlink(`${f.path}.lock`);
  await f.store.save(scope, saved.revision, []);
  expect((await f.store.load(scope)).grants).toEqual([]);
});

/** Serialized output is bounded before any file mutation. An owned temporary collision cannot delete someone else's bytes. */
it('bounds writes and preserves an exclusive temporary creation collision', async () => {
  const f = await fixture();
  const snapshot = await f.store.load(scope);
  await expect(f.store.save(scope, snapshot.revision, [{ ...grant, id: 'x'.repeat(65_537) }])).rejects.toThrow(
    'size limit',
  );
  const open: typeof fs.open = async (...args) => {
    if (String(args[0]).endsWith('.tmp')) {
      await fs.writeFile(args[0], 'other writer');
    }
    return fs.open(...args);
  };
  await expect(
    new FileApprovalStore(f.directory, { ...fs, open }).save(scope, snapshot.revision, [grant]),
  ).rejects.toThrow();
  const files = await fs.readdir(f.directory);
  expect(files).toHaveLength(1);
  expect(await fs.readFile(join(f.directory, files[0]!), 'utf8')).toBe('other writer');
});
