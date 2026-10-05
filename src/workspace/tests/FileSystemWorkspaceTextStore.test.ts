import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditError } from '../../editing/EditError.ts';
import { EditFailureReason } from '../../editing/EditFailureReason.ts';
import { FileSystemWorkspaceTextStore } from '../FileSystemWorkspaceTextStore.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(FileSystemWorkspaceTextStore, () => {
describe(FileSystemWorkspaceTextStore.prototype.read, () => {
it('preserves UTF-8 BOM, mixed line endings, whitespace, and raw-byte revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-store-'));
  directories.push(root);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\nc\r\t  ')]);
  await writeFile(join(root, 'mixed.txt'), bytes);
  const store = new FileSystemWorkspaceTextStore(root);

  const snapshot = await store.read('mixed.txt');

  expect(snapshot.text).toBe('a\r\nb\nc\r\t  ');
  expect(snapshot.bom).toBe(true);
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
});

describe(FileSystemWorkspaceTextStore.prototype.replace, () => {
it('uses an exact revision precondition and preserves mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-store-cas-'));
  directories.push(root);
  await writeFile(join(root, 'file.txt'), 'base\n', { mode: 0o640 });
  const store = new FileSystemWorkspaceTextStore(root);
  const base = await store.read('file.txt');
  await writeFile(join(root, 'file.txt'), 'collaborator\n');

  await expect(store.replace('file.txt', base.revision, 'agent\n', false)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator\n');
});
});
});
