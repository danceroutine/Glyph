import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditError } from '../../editing/errors/EditError.ts';
import { EditFailureReason } from '../../editing/errors/EditFailureReason.ts';
import { FileSystemWorkspaceTextStore } from '../FileSystemWorkspaceTextStore.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(FileSystemWorkspaceTextStore, () => {
  describe(FileSystemWorkspaceTextStore.prototype.read, () => {
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
      const base = await store.read('file.txt');
      await writeFile(join(root, 'file.txt'), 'collaborator\n');

      await expect(store.replace('file.txt', base.revision, 'agent\n', false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator\n');
    });
  });
});
