import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(FileSystemWorkspaceTextStore, () => {
  describe(FileSystemWorkspaceTextStore.prototype.read, () => {
    it('[round9-02] preserves a literal leading U+FEFF after the encoding BOM during an unrelated edit', async () => {
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
      '[review-01] refuses protected path %s under case-insensitive policy before returning its contents',
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
  });
});
