import { outsideWorkspace } from '#src/shell/TrustedHostExecutable.js';
import { SkillRepositoryGit } from './SkillRepositoryGit.ts';
import { indexedPackageDirectories } from './listSkillPackageFiles.ts';
import { inventoryPackage } from './skillPackageInventory.ts';
import { basename, join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { SkillPackageDraft } from './SkillPackageDraft.ts';
import { inspectFileMetadata, type FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';
import type { RepositoryWorkspaceRoots } from './SkillRepositoryAuthority.ts';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

export const skillPackageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('repository'),
      url: z.url().startsWith('https://'),
      revision: z.string().min(1).max(200),
      directory: z.string().max(1000),
    })
    .strict(),
]);
export type SkillPackageSource = z.infer<typeof skillPackageSourceSchema>;
/** Reads selected packages without checking out repositories, following symlinks, or executing package code. */
export class SkillPackageSourceReader {
  constructor(
    private readonly binaryPath: string,
    workspaceRoots: readonly string[],
    private readonly metadata: FilesystemMetadata & HostFilesystemAuthority,
    private readonly hostWorkspaceRoots: RepositoryWorkspaceRoots = workspaceRoots,
  ) {}
  async read(input: SkillPackageSource, signal?: AbortSignal): Promise<SkillPackageDraft> {
    const source = skillPackageSourceSchema.parse(input);
    if (source.kind === 'local') {
      const root = resolve(source.path);
      if ((await lstat(root)).isSymbolicLink()) throw new Error('Skill sources cannot be symlinked directories.');
      await inspectFileMetadata(this.metadata, root, 'replaceable');
      const store = new FileSystemWorkspaceTextStore(root);
      const index = new RustWorkspacePathIndex({
        root,
        maxFiles: 257,
        binaryPath: this.binaryPath,
        caseSensitive: store.caseSensitive,
        respectGitIgnore: false,
      });
      try {
        const state = await index.refresh(signal);
        if (state.truncated) throw new Error('Skill source exceeds the file budget.');
        const list = await index.glob('**/*', { limit: 257, ...(signal ? { signal } : {}) });
        if (list.truncated) throw new Error('Skill source exceeds the file budget.');
        const inventory = await inventoryPackage(root, signal);
        const modes = await indexedPackageDirectories(index, path => store.resolvePath(path), signal);
        for (const path of modes.keys())
          await inspectFileMetadata(this.metadata, await store.resolvePath(path), 'replaceable');
        const indexed = new Set(list.files);
        if (
          indexed.size !== inventory.files.length ||
          inventory.files.some(path => !indexed.has(path)) ||
          inventory.directories.some(path => !modes.has(path))
        )
          throw new Error('Skill source contains excluded or unindexed files.');
        const files = [];
        let bytes = 0;
        for (const path of list.files) {
          signal?.throwIfAborted();
          const file = await store.readBytes(path, { maxBytes: 1024 * 1024, metadata: this.metadata });
          bytes += file.bytes.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error('Skill source exceeds 8 MiB.');
          files.push({
            path,
            mode: file.mode,
            content: Buffer.from(file.bytes).toString('base64'),
            encoding: 'base64' as const,
          });
        }
        return new SkillPackageDraft({
          name: basename(root),
          source: root,
          files,
          directories: [...modes].map(([path, mode]) => ({ path, mode })),
        });
      } finally {
        await index.dispose();
      }
    }
    const url = new URL(source.url);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        'Use a repository URL without embedded credentials, query parameters, or fragments. Configure Git authentication separately.',
      );
    if (
      source.directory.split('/').some(part => part === '..') ||
      /[\\\0:]/u.test(source.directory) ||
      source.directory.startsWith('/')
    )
      throw new Error('Repository package directory must be relative.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(source.revision) || source.revision.includes('..'))
      throw new Error('Select a commit, branch or tag.');
    const currentRoots =
      typeof this.hostWorkspaceRoots === 'function' ? this.hostWorkspaceRoots() : this.hostWorkspaceRoots;
    const temporary = await mkdtemp(join(outsideWorkspace(tmpdir(), currentRoots), 'glyph-skill-repository-'));
    const deadline = AbortSignal.timeout(60_000);
    try {
      await inspectPrivateDirectory(this.metadata, temporary);
      const storage = join(temporary, '.skill-staging');
      await mkdir(storage, { mode: 0o700 });
      await inspectPrivateDirectory(this.metadata, storage);
      const transport = new SkillRepositoryGit(
        storage,
        signal ? AbortSignal.any([signal, deadline]) : deadline,
        this.hostWorkspaceRoots,
        this.metadata,
      );
      const git = async (...args: string[]) => {
        const bytes = await transport.run(args);
        try {
          return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new Error(
            'Repository paths must use valid UTF-8. Rename the affected file before importing the skill.',
          );
        }
      };
      await transport.initialize(source.url);
      await git(
        '--git-dir=source.git',
        'fetch',
        '--depth=1',
        '--no-tags',
        '--filter=blob:none',
        '--no-recurse-submodules',
        'origin',
        source.revision,
      );
      const revision = (
        await git('--git-dir=source.git', 'rev-parse', '--verify', '--end-of-options', 'FETCH_HEAD^{commit}')
      ).trim();
      const tree = source.directory ? `${revision}:${source.directory.replace(/\/$/u, '')}` : revision;
      const entries = (await git('--git-dir=source.git', 'ls-tree', '-r', '-t', '-z', tree))
        .split('\0')
        .filter(Boolean);
      if (entries.length > 8450) throw new Error('Skill source exceeds its directory budget.');
      const directories = [];
      const blobs = [];
      for (const entry of entries) {
        const subtree = /^040000 tree [a-f0-9]+\t(.+)$/su.exec(entry);
        if (subtree) directories.push({ path: subtree[1]!, mode: 0o755 });
        else blobs.push(entry);
      }
      if (blobs.length > 256) throw new Error('Skill source exceeds 256 files.');
      const files = [];
      let bytes = 0;
      for (const entry of blobs) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/su.exec(entry);
        if (!match) throw new Error('Skill repositories cannot contain symlinks or submodules.');
        const blob = await transport.run(['--git-dir=source.git', 'cat-file', 'blob', match[2]!], 1024 * 1024);
        bytes += blob.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('Skill source exceeds 8 MiB.');
        files.push({
          path: match[3]!,
          mode: match[1] === '100755' ? 0o755 : 0o644,
          content: blob.toString('base64'),
          encoding: 'base64' as const,
        });
      }
      return new SkillPackageDraft({
        name: basename(source.directory || url.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '')),
        source: `Requested repository ${source.url}@${revision}${source.directory ? `:${source.directory}` : ''}`,
        files,
        directories,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
