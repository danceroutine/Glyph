import { posix } from 'node:path';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../../errors/ConfigurationError.ts';
import type { WorkspaceMutationOptions } from '../../../workspace/WorkspaceMutationOptions.ts';
import type { WorkspaceTextSnapshot } from '../../../workspace/WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from '../../../workspace/WorkspaceTextStore.ts';
import { WorkspaceMutationConsistency } from '../../../workspace/WorkspaceMutationConsistency.ts';
import { ContextAttachmentError } from '../ContextAttachmentError.ts';
import { ContextAttachmentFailureReason } from '../ContextAttachmentFailureReason.ts';
import { ContextAttachmentService } from '../ContextAttachmentService.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';

class MutableWorkspaceTextStore implements WorkspaceTextStore {
  readonly root = '/workspace';
  readonly mutationConsistency = WorkspaceMutationConsistency.ATOMIC_VERSIONED;
  readonly reads: string[] = [];
  private readonly snapshots = new Map<string, WorkspaceTextSnapshot>();

  constructor(readonly caseSensitive = true) {}

  set(path: string, text: string, revision: string, byteOrderMark = false): void {
    const normalized = this.normalizePath(path);
    const content = Buffer.from(text, 'utf8');
    const byteLength = content.byteLength + (byteOrderMark ? 3 : 0);
    this.snapshots.set(this.key(normalized), {
      path: normalized,
      text,
      revision,
      byteOrderMark,
      byteLength,
      mode: 0o644,
      identity: `fixture:${normalized}`,
    });
  }

  normalizePath(path: string): string {
    if (!path || posix.isAbsolute(path)) throw new Error('Path must be project-relative.');
    const normalized = posix.normalize(path);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../'))
      throw new Error('Path escapes root.');
    return normalized;
  }

  async read(path: string): Promise<WorkspaceTextSnapshot> {
    const normalized = this.normalizePath(path);
    this.reads.push(normalized);
    const snapshot = this.snapshots.get(this.key(normalized));
    if (!snapshot) throw new Error('Missing fixture file.');
    return { ...snapshot };
  }

  async readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined> {
    try {
      return await this.read(path);
    } catch {
      return undefined;
    }
  }

  async list(): Promise<{ files: string[]; truncated: boolean }> {
    return { files: [...this.snapshots.values()].map(snapshot => snapshot.path), truncated: false };
  }

  async create(
    _path: string,
    _text: string,
    _byteOrderMark: boolean,
    _mode?: number,
    _options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    throw new Error('Not implemented by this fixture.');
  }

  async replace(
    _path: string,
    _expectedRevision: string,
    _text: string,
    _byteOrderMark: boolean,
    _options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    throw new Error('Not implemented by this fixture.');
  }

  async rename(
    _source: string,
    _target: string,
    _expectedRevision: string,
    _options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    throw new Error('Not implemented by this fixture.');
  }

  async delete(_path: string, _expectedRevision: string, _options?: WorkspaceMutationOptions): Promise<void> {
    throw new Error('Not implemented by this fixture.');
  }

  private key(path: string): string {
    return this.caseSensitive ? path : path.toLowerCase();
  }
}

describe(ContextAttachmentService, () => {
  it('rejects invalid limits with the shared typed configuration error', () => {
    const workspace = new MutableWorkspaceTextStore();

    expect(() => new ContextAttachmentService(workspace, { maxFiles: 0 })).toThrow(ConfigurationError);
  });

  describe(ContextAttachmentService.prototype.resolve, () => {
    it('normalizes and deduplicates references while preserving first-seen order and exact metadata', async () => {
      const workspace = new MutableWorkspaceTextStore(false);
      workspace.set('src/alpha.ts', 'alpha', 'revision-alpha', true);
      workspace.set('src/beta.ts', 'beta', 'revision-beta');
      const service = new ContextAttachmentService(workspace);

      const attachments = await service.resolve([
        { path: 'src/./alpha.ts' },
        { path: 'SRC/alpha.ts' },
        { path: 'src/beta.ts' },
      ]);

      expect(workspace.reads).toEqual(['src/alpha.ts', 'src/beta.ts']);
      expect(attachments).toEqual([
        {
          path: 'src/alpha.ts',
          revision: 'revision-alpha',
          text: 'alpha',
          byteOrderMark: true,
          byteLength: 8,
        },
        {
          path: 'src/beta.ts',
          revision: 'revision-beta',
          text: 'beta',
          byteOrderMark: false,
          byteLength: 4,
        },
      ]);
    });

    it('re-reads referenced files on every resolution instead of caching draft-time content', async () => {
      const workspace = new MutableWorkspaceTextStore();
      workspace.set('src/App.tsx', 'before', 'revision-before');
      const service = new ContextAttachmentService(workspace);
      const references = [{ path: 'src/App.tsx' }] as const;

      expect((await service.resolve(references))[0]).toMatchObject({ text: 'before', revision: 'revision-before' });
      workspace.set('src/App.tsx', 'after', 'revision-after');
      expect((await service.resolve(references))[0]).toMatchObject({ text: 'after', revision: 'revision-after' });
      expect(workspace.reads).toEqual(['src/App.tsx', 'src/App.tsx']);
    });

    it('counts normalized unique references against the file limit', async () => {
      const workspace = new MutableWorkspaceTextStore();
      workspace.set('one.ts', 'one', 'one');
      workspace.set('two.ts', 'two', 'two');
      const service = new ContextAttachmentService(workspace, { maxFiles: 1 });

      await expect(service.resolve([{ path: './one.ts' }, { path: 'one.ts' }])).resolves.toHaveLength(1);
      await expect(service.resolve([{ path: 'one.ts' }, { path: 'two.ts' }])).rejects.toMatchObject({
        reason: ContextAttachmentFailureReason.FILE_COUNT_LIMIT_EXCEEDED,
        details: { limit: 1, actual: 2 },
      });
    });

    it('rejects a file whose exact byte length exceeds the per-file limit', async () => {
      const workspace = new MutableWorkspaceTextStore();
      workspace.set('large.ts', '12345', 'large');
      const service = new ContextAttachmentService(workspace, { maxFileBytes: 4, maxTotalBytes: 10 });

      await expect(service.resolve([{ path: 'large.ts' }])).rejects.toMatchObject({
        reason: ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED,
        details: { path: 'large.ts', limit: 4, actual: 5 },
      });
    });

    it('rejects attachments whose combined exact byte lengths exceed the total limit', async () => {
      const workspace = new MutableWorkspaceTextStore();
      workspace.set('one.ts', '123', 'one');
      workspace.set('two.ts', '456', 'two');
      const service = new ContextAttachmentService(workspace, { maxFileBytes: 4, maxTotalBytes: 5 });

      await expect(service.resolve([{ path: 'one.ts' }, { path: 'two.ts' }])).rejects.toMatchObject({
        reason: ContextAttachmentFailureReason.TOTAL_SIZE_LIMIT_EXCEEDED,
        details: { path: 'two.ts', limit: 5, actual: 6 },
      });
    });

    it('reports invalid references and read failures through the attachment error taxonomy', async () => {
      const service = new ContextAttachmentService(new MutableWorkspaceTextStore());

      await expect(service.resolve([{ path: '../outside.ts' }])).rejects.toBeInstanceOf(ContextAttachmentError);
      await expect(service.resolve([{ path: '../outside.ts' }])).rejects.toMatchObject({
        reason: ContextAttachmentFailureReason.INVALID_REFERENCE,
      });
      await expect(service.resolve([{ path: 'missing.ts' }])).rejects.toMatchObject({
        reason: ContextAttachmentFailureReason.READ_FAILED,
        details: { path: 'missing.ts' },
      });
    });

    it('applies the shared workspace access policy to attachment paths', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-attachment-policy-'));
      try {
        await writeFile(join(root, '.git-credentials'), 'https://user:synthetic@example.test');
        const service = new ContextAttachmentService(new FileSystemWorkspaceTextStore(root));

        await expect(service.resolve([{ path: '.git-credentials' }])).rejects.toMatchObject({
          reason: ContextAttachmentFailureReason.INVALID_REFERENCE,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
