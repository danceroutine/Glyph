import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';

vi.mock('node:fs/promises', { spy: true });

const directories: string[] = [];

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspaceRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

function filesystemError(code: string | undefined, message = code ?? 'filesystem failure'): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  if (code !== undefined) error.code = code;
  return error;
}

async function actualFileSystem() {
  return vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
}

describe(FileSystemWorkspaceTextStore, () => {
  it.each(['\ud800', '\udc00', 'folder/\ud800.txt', 'folder/\udc00.txt'])(
    'rejects malformed Unicode path %j before resolving a filesystem key',
    async path => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-malformed-path-'));
      directories.push(root);
      const store = new FileSystemWorkspaceTextStore(root);
      await expect(store.canonicalPath(path)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      expect(() => store.normalizePath(path)).toThrow();
      expect(() => new FileSystemWorkspaceTextStore(join(root, path))).toThrow();
    },
  );

  it('resolves prospective paths through root aliases without reading content or creating parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-canonical-'));
    directories.push(root);
    await mkdir(join(root, 'repo', 'pkg'), { recursive: true });
    await symlink(join(root, 'repo', 'pkg'), join(root, 'alias'));
    const parent = new FileSystemWorkspaceTextStore(join(root, 'repo'));
    const child = new FileSystemWorkspaceTextStore(join(root, 'alias'));
    const read = vi.spyOn(parent, 'read');
    const canonical = await parent.canonicalPath('pkg/new/deep/file.txt');
    expect(canonical).toBe(await child.canonicalPath('new/deep/file.txt'));
    await expect(realpath(join(root, 'repo', 'pkg', 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves path policy, directory boundaries, and child-symlink exclusions when resolving prospective paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-canonical-policy-'));
    directories.push(root);
    await mkdir(join(root, 'directory'));
    await writeFile(join(root, 'file'), 'base');
    await symlink(join(root, 'directory'), join(root, 'alias'));
    const store = new FileSystemWorkspaceTextStore(root, { caseSensitive: false });
    for (const path of ['.ENV', 'alias/new', 'file/new']) {
      await expect(store.canonicalPath(path)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    }
    await expect(store.canonicalPath('../outside')).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    expect(await store.canonicalPath('New/Child')).toBe(await store.canonicalPath('new/child'));
    expect(await store.canonicalPath('new')).not.toBe(await store.canonicalPath('newer'));
  });

  it('checks occupied and missing targets using metadata while retaining policy and symlink exclusions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-exists-'));
    directories.push(root);
    await writeFile(join(root, 'binary.txt'), Buffer.from([0, 255]));
    await mkdir(join(root, 'directory'));
    await symlink(join(root, 'binary.txt'), join(root, 'alias.txt'));
    const store = new FileSystemWorkspaceTextStore(root);
    const read = vi.spyOn(store, 'read');
    await expect(store.exists('binary.txt')).resolves.toBe(true);
    await expect(store.exists('directory')).resolves.toBe(true);
    await expect(store.exists('new/path.txt')).resolves.toBe(false);
    await expect(store.exists('.env')).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    await expect(store.exists('alias.txt')).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an occupied rename target without decoding it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-rename-metadata-'));
    directories.push(root);
    const store = new FileSystemWorkspaceTextStore(root);
    const source = await store.create('source.txt', 'base', false);
    await writeFile(join(root, 'target.txt'), Buffer.from([0, 255]));
    const read = vi.spyOn(store, 'read');
    await expect(store.rename('source.txt', 'target.txt', source.revision)).rejects.toMatchObject({
      reason: EditFailureReason.STALE,
    });
    expect(read.mock.calls.some(([path]) => path === 'target.txt')).toBe(false);
  });
  it.each(['invalid\0text', '\ud800', '\udc00'])(
    'rejects unsupported text %j in creates and replacements without modifying the filesystem',
    async text => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-nul-mutation-'));
      directories.push(root);
      const store = new FileSystemWorkspaceTextStore(root);
      const base = await store.create('existing.txt', 'original', false);
      await expect(store.create('new.txt', text, false)).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
      await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(store.replace('existing.txt', base.revision, text, false)).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('original');
    },
  );

  describe(FileSystemWorkspaceTextStore.prototype.read, () => {
    it('preserves a literal leading U+FEFF after the encoding BOM during an unrelated edit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-double-bom-'));
      directories.push(root);
      await writeFile(join(root, 'text.txt'), Buffer.from('efbbbfefbbbf61', 'hex'));
      const store = new FileSystemWorkspaceTextStore(root);
      const before = await store.read('text.txt');
      await store.replace('text.txt', before.revision, `${before.text}!`, before.byteOrderMark);
      expect((await readFile(join(root, 'text.txt'))).toString('hex')).toBe('efbbbfefbbbf6121');
    });
    it('accepts an exact byte budget and rejects oversized UTF-8 input before decoding', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-budget-'));
      directories.push(root);
      await writeFile(join(root, 'text.txt'), 'é🙂');
      const store = new FileSystemWorkspaceTextStore(root);
      await expect(store.read('text.txt', { maxBytes: 6 })).resolves.toMatchObject({ text: 'é🙂', byteLength: 6 });
      await expect(store.readOptional('text.txt', { maxBytes: 5 })).rejects.toMatchObject({
        maxBytes: 5,
        actualBytes: 6,
      });
      await expect(store.readOptional('missing.txt', { maxBytes: 0 })).resolves.toBeUndefined();
    });

    it.each(['.ENV', '.GIT/config'])(
      'refuses protected path %s under case-insensitive policy before returning its contents',
      async path => {
        const root = await mkdtemp(join(tmpdir(), 'workspace-case-policy-'));
        directories.push(root);
        await mkdir(join(root, '.GIT'));
        // Uppercase fixture names make the policy regression reproducible even
        // on a case-sensitive CI volume. These are synthetic, harmless canaries.
        await writeFile(join(root, path), 'fixture-only-protected-content');
        await writeFile(join(root, 'public.txt'), 'public fixture');
        const store = new FileSystemWorkspaceTextStore(root, { caseSensitive: false });
        await expect(store.read('public.txt')).resolves.toMatchObject({ text: 'public fixture' });
        await expect(store.read(path)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      },
    );

    it('preserves the UTF-8 byte order mark, mixed line endings, whitespace, and raw-byte revisions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-store-'));
      directories.push(root);
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\nc\r\t  ')]);
      await writeFile(join(root, 'mixed.txt'), bytes);
      const store = new FileSystemWorkspaceTextStore(root);

      const snapshot = await store.read('mixed.txt');

      expect(snapshot.text).toBe('a\r\nb\nc\r\t  ');
      expect(snapshot.byteOrderMark).toBe(true);
      expect(snapshot.byteLength).toBe(bytes.length);
      expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects invalid UTF-8, NUL content, and paths outside the workspace', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-store-invalid-'));
      directories.push(root);
      const store = new FileSystemWorkspaceTextStore(root);
      await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
      await writeFile(join(root, 'binary.txt'), Buffer.from('a\0b'));

      await expect(store.read('invalid.txt')).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      await expect(store.read('binary.txt')).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      await expect(store.read('../outside.txt')).rejects.toBeInstanceOf(EditError);
    });

    it('excludes exact files and directory subtrees before allowed-file exceptions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-store-excluded-'));
      directories.push(root);
      await mkdir(join(root, '.glyph-state'));
      await mkdir(join(root, 'logs'));
      await writeFile(join(root, '.glyph-state', 'accounts.json'), '{"refreshToken":"secret"}');
      await writeFile(join(root, '.glyph-state', '.env.example'), 'SECRET=still-private');
      await writeFile(join(root, 'logs', 'provider.jsonl'), '{"project":"content"}\n');
      await writeFile(join(root, 'logs', 'provider.jsonl.backup'), 'kept\n');
      const store = new FileSystemWorkspaceTextStore(root, {
        excludedPaths: ['.glyph-state', 'logs/provider.jsonl'],
      });

      await expect(store.list(20)).resolves.toEqual({
        files: ['logs/provider.jsonl.backup'],
        truncated: false,
      });
      await expect(store.read('.glyph-state/accounts.json')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
      await expect(store.read('.glyph-state/.env.example')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
      await expect(store.read('logs/provider.jsonl')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
      await expect(store.read('logs/provider.jsonl.backup')).resolves.toMatchObject({ text: 'kept\n' });
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.replace, () => {
    it('uses an exact revision precondition and preserves mode', async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-store-cas-'));
      directories.push(root);
      await writeFile(join(root, 'file.txt'), 'base\n', { mode: 0o640 });
      const store = new FileSystemWorkspaceTextStore(root);
      expect(store.mutationConsistency).toBe(WorkspaceMutationConsistency.BEST_EFFORT_FILESYSTEM);
      const base = await store.read('file.txt');
      await writeFile(join(root, 'file.txt'), 'collaborator\n');

      await expect(store.replace('file.txt', base.revision, 'agent\n', false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator\n');
    });

    it('reports a missing file as stale without a current revision', async () => {
      const root = await workspaceRoot('workspace-replace-missing-');
      const store = new FileSystemWorkspaceTextStore(root);

      const error = await store.replace('missing.txt', 'revision', 'agent\n', false).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: EditFailureReason.STALE });
      expect((error as EditError).details).not.toHaveProperty('currentRevision');
    });

    it('surfaces a failure to clean up the temporary replacement file', async () => {
      const root = await workspaceRoot('workspace-replace-cleanup-');
      await writeFile(join(root, 'file.txt'), 'base\n');
      const store = new FileSystemWorkspaceTextStore(root);
      const base = await store.read('file.txt');
      const failure = filesystemError('EPERM');
      vi.mocked(unlink).mockRejectedValueOnce(failure);

      await expect(store.replace('file.txt', base.revision, 'agent\n', false)).rejects.toBe(failure);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('agent\n');
    });

    it('surfaces a cleanup failure that carries no error code', async () => {
      const root = await workspaceRoot('workspace-replace-cleanup-uncoded-');
      await writeFile(join(root, 'file.txt'), 'base\n');
      const store = new FileSystemWorkspaceTextStore(root);
      const base = await store.read('file.txt');
      const failure = filesystemError(undefined);
      vi.mocked(unlink).mockRejectedValueOnce(failure);

      await expect(store.replace('file.txt', base.revision, 'agent\n', false)).rejects.toBe(failure);
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.normalizePath, () => {
    it.each(['.', 'folder/..'])('rejects %j because it names the project root directory', path => {
      const store = new FileSystemWorkspaceTextStore(tmpdir());

      expect(() => store.normalizePath(path)).toThrow(
        expect.objectContaining({
          reason: EditFailureReason.UNSUPPORTED,
          message: 'Directory operations are not supported.',
        }),
      );
    });
  });

  it('treats a path without a final segment as not sensitive', () => {
    const store = new FileSystemWorkspaceTextStore(tmpdir(), { caseSensitive: true });
    const internals = store as unknown as { isExcluded(path: unknown): boolean };

    expect(internals.isExcluded({ split: () => [] })).toBe(false);
  });

  describe(FileSystemWorkspaceTextStore.prototype.canonicalPath, () => {
    it('reports an ancestor that stops being a directory while resolving as unsupported', async () => {
      const root = await workspaceRoot('workspace-canonical-race-');
      await mkdir(join(root, 'directory'));
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      vi.mocked(realpath).mockImplementation(async path =>
        path === join(store.root, 'directory', 'file.txt')
          ? Promise.reject(filesystemError('ENOTDIR'))
          : actual.realpath(path),
      );

      await expect(store.canonicalPath('directory/file.txt')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'A parent path is not a directory.',
      });
    });

    it('fails when the project root disappears while resolving a prospective path', async () => {
      const root = await workspaceRoot('workspace-canonical-root-race-');
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      const missing = filesystemError('ENOENT');
      let rootResolutions = 0;
      vi.mocked(realpath).mockImplementation(async path => {
        if (path === store.root && rootResolutions++ === 0) return actual.realpath(path);
        if (path === store.root) throw missing;
        return actual.realpath(path);
      });

      await expect(store.canonicalPath('new/file.txt')).rejects.toBe(missing);
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.list, () => {
    it('rejects a project root that is not a directory', async () => {
      const root = await workspaceRoot('workspace-list-file-root-');
      await writeFile(join(root, 'file.txt'), 'not a directory');
      const store = new FileSystemWorkspaceTextStore(join(root, 'file.txt'));

      await expect(store.list(10)).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'The target directory is not a directory.',
        details: { path: '.' },
      });
    });

    it('stops visiting sibling directories once a nested directory reaches the limit', async () => {
      const root = await workspaceRoot('workspace-list-nested-limit-');
      await mkdir(join(root, 'a'));
      await mkdir(join(root, 'b'));
      await writeFile(join(root, 'a', 'one.ts'), 'one');
      await writeFile(join(root, 'a', 'two.ts'), 'two');
      await writeFile(join(root, 'b', 'three.ts'), 'three');
      const store = new FileSystemWorkspaceTextStore(root);

      await expect(store.list(1)).resolves.toEqual({ files: ['a/one.ts'], truncated: true });
    });

    it.skipIf(process.platform === 'win32')('skips entries that are neither files nor directories', async () => {
      const root = await workspaceRoot('wl-');
      await writeFile(join(root, 'file.ts'), 'file');
      const server = createServer();
      await new Promise<void>(resolve => server.listen(join(root, 's'), resolve));
      onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
      const store = new FileSystemWorkspaceTextStore(root);

      await expect(store.list(10)).resolves.toEqual({ files: ['file.ts'], truncated: false });
    });

    it('applies exclusions with exact case when case sensitive', async () => {
      const root = await workspaceRoot('workspace-list-case-sensitive-');
      await mkdir(join(root, 'Private'));
      await writeFile(join(root, 'Private', 'kept.ts'), 'kept');
      const sensitive = new FileSystemWorkspaceTextStore(root, { caseSensitive: true, excludedPaths: ['private'] });
      const insensitive = new FileSystemWorkspaceTextStore(root, { caseSensitive: false, excludedPaths: ['private'] });

      await expect(sensitive.list(10, '*.ts')).resolves.toEqual({ files: ['Private/kept.ts'], truncated: false });
      await expect(insensitive.list(10, '*.ts')).resolves.toEqual({ files: [], truncated: false });
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.create, () => {
    it('reports an existing target as stale', async () => {
      const root = await workspaceRoot('workspace-create-exists-');
      await writeFile(join(root, 'file.txt'), 'collaborator');
      const store = new FileSystemWorkspaceTextStore(root);

      await expect(store.create('file.txt', 'agent', false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        message: 'The create target now exists.',
      });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator');
    });

    it('removes parent directories it created when writing the file fails', async () => {
      const root = await workspaceRoot('workspace-create-rollback-');
      const store = new FileSystemWorkspaceTextStore(root);
      const failure = filesystemError('EACCES');
      vi.mocked(open).mockRejectedValueOnce(failure);

      await expect(store.create('new/deep/file.txt', 'agent', false)).rejects.toBe(failure);
      await expect(lstat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
      ['a coded', 'EPERM'],
      ['an uncoded', undefined],
    ])('surfaces %s failure to remove a created parent directory', async (_description, code) => {
      const root = await workspaceRoot('workspace-create-rollback-failure-');
      const store = new FileSystemWorkspaceTextStore(root);
      const rollback = filesystemError(code);
      vi.mocked(open).mockRejectedValueOnce(filesystemError('EACCES'));
      vi.mocked(rmdir).mockRejectedValueOnce(rollback);

      await expect(store.create('new/file.txt', 'agent', false)).rejects.toBe(rollback);
    });

    it('reports a parent replaced by a file before its directories are created as unsupported', async () => {
      const root = await workspaceRoot('workspace-create-parent-race-');
      await mkdir(join(root, 'parent'));
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      vi.mocked(stat).mockImplementationOnce(async path => {
        await actual.rm(join(root, 'parent'), { recursive: true });
        await actual.writeFile(join(root, 'parent'), 'collaborator');
        return actual.stat(path);
      });

      await expect(store.create('parent/file.txt', 'agent', false)).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'A parent path is not a directory.',
      });
    });

    it('surfaces a failure to create a missing parent directory', async () => {
      const root = await workspaceRoot('workspace-create-mkdir-race-');
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      vi.mocked(mkdir).mockImplementationOnce(async (path, options) => {
        await actual.writeFile(path, 'collaborator');
        return actual.mkdir(path, options);
      });

      await expect(store.create('parent/file.txt', 'agent', false)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(join(root, 'parent'), 'utf8')).toBe('collaborator');
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.rename, () => {
    it('reports a target created concurrently as stale and keeps the collaborator directory', async () => {
      const root = await workspaceRoot('workspace-rename-race-');
      await writeFile(join(root, 'source.txt'), 'agent');
      const store = new FileSystemWorkspaceTextStore(root);
      const source = await store.read('source.txt');
      const actual = await actualFileSystem();
      vi.mocked(link).mockImplementationOnce(async (existing, target) => {
        await actual.writeFile(target, 'collaborator');
        return actual.link(existing, target);
      });

      await expect(store.rename('source.txt', 'new/target.txt', source.revision)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        message: 'The rename target now exists.',
        details: { path: 'new/target.txt' },
      });
      expect(await readFile(join(root, 'new', 'target.txt'), 'utf8')).toBe('collaborator');
      expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('agent');
    });
  });

  describe(FileSystemWorkspaceTextStore.prototype.read, () => {
    it('rejects a file replaced by a symbolic link after its ancestors were inspected', async () => {
      const root = await workspaceRoot('workspace-read-symlink-race-');
      await writeFile(join(root, 'file.txt'), 'original');
      await writeFile(join(root, 'other.txt'), 'other');
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      vi.mocked(lstat).mockImplementationOnce(async path => {
        const info = await actual.lstat(path);
        await actual.unlink(join(root, 'file.txt'));
        await actual.symlink(join(root, 'other.txt'), join(root, 'file.txt'));
        return info;
      });

      await expect(store.read('file.txt')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'Symbolic links are not supported.',
      });
    });

    it.each([-1, 1.5, Number.NaN])('rejects the invalid read budget %s', async maxBytes => {
      const root = await workspaceRoot('workspace-read-budget-');
      await writeFile(join(root, 'file.txt'), 'text');
      const store = new FileSystemWorkspaceTextStore(root);

      await expect(store.read('file.txt', { maxBytes })).rejects.toThrow('Read budget must be a non-negative integer.');
    });

    it('rejects a bounded read whose handle cannot report how many bytes it read', async () => {
      const root = await workspaceRoot('workspace-read-unsized-');
      await writeFile(join(root, 'file.txt'), 'text');
      const store = new FileSystemWorkspaceTextStore(root);
      const actual = await actualFileSystem();
      const info = await actual.stat(join(root, 'file.txt'));
      const handle = {
        stat: vi.fn(async () => info),
        read: vi.fn(async () => ({ bytesRead: Number.NaN })),
        close: vi.fn(async () => {}),
      };
      vi.mocked(open).mockResolvedValueOnce(handle as unknown as FileHandle);

      const error = await store.read('file.txt', { maxBytes: 64 }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WorkspaceReadLimitError);
      expect(error).toMatchObject({ path: 'file.txt', maxBytes: 64, actualBytes: Number.NaN });
      expect(handle.close).toHaveBeenCalledOnce();
    });

    it('opens files without POSIX-only flags on Windows', async () => {
      const root = await workspaceRoot('workspace-read-windows-');
      await writeFile(join(root, 'file.txt'), 'text');
      const store = new FileSystemWorkspaceTextStore(root);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', platform);
      });

      await expect(store.read('file.txt')).resolves.toMatchObject({ text: 'text' });
      expect(vi.mocked(open)).toHaveBeenCalledWith(expect.any(String), constants.O_RDONLY);
    });
  });
});
