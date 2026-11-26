import { execFile, type ExecFileOptions } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { SkillPackageDraft } from './SkillPackageDraft.ts';

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
function run(
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((settle, reject) => {
    execFile(command, args, { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(error.message, { cause: error }));
      else settle({ stdout, stderr });
    });
  });
}
/** Reads selected packages without checking out repositories, following symlinks, or executing package code. */
export class SkillPackageSourceReader {
  constructor(private readonly binaryPath: string) {}
  async read(input: SkillPackageSource, signal?: AbortSignal): Promise<SkillPackageDraft> {
    const source = skillPackageSourceSchema.parse(input);
    if (source.kind === 'local') {
      const root = resolve(source.path);
      if ((await lstat(root)).isSymbolicLink()) throw new Error('Skill sources cannot be symlinked directories.');
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
        const files = [];
        let bytes = 0;
        for (const path of list.files) {
          signal?.throwIfAborted();
          const file = await store.readBytes(path, { maxBytes: 1024 * 1024 });
          bytes += file.bytes.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error('Skill source exceeds 8 MiB.');
          files.push({ path, content: Buffer.from(file.bytes).toString('base64'), encoding: 'base64' as const });
        }
        return new SkillPackageDraft({ name: basename(root), source: root, files });
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
    const temporary = await mkdtemp(join(tmpdir(), 'glyph-skill-repository-'));
    const git = async (...args: string[]) =>
      (
        await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
          cwd: temporary,
          ...(signal ? { signal } : {}),
          timeout: 60000,
          maxBuffer: 12 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
      ).stdout.toString('utf8');
    try {
      await git('clone', '--bare', '--filter=blob:none', '--', source.url, 'source.git');
      const revision = (
        await git('--git-dir=source.git', 'rev-parse', '--verify', '--end-of-options', `${source.revision}^{commit}`)
      ).trim();
      const tree = source.directory ? `${revision}:${source.directory.replace(/\/$/u, '')}` : revision;
      const entries = (await git('--git-dir=source.git', 'ls-tree', '-r', '-z', tree)).split('\0').filter(Boolean);
      if (entries.length > 256) throw new Error('Skill source exceeds 256 files.');
      const files = [];
      let bytes = 0;
      for (const entry of entries) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/su.exec(entry);
        if (!match) throw new Error('Skill repositories cannot contain symlinks or submodules.');
        const blob = await run('git', ['--git-dir=source.git', 'cat-file', 'blob', match[2]!], {
          cwd: temporary,
          encoding: 'buffer',
          ...(signal ? { signal } : {}),
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        });
        bytes += blob.stdout.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('Skill source exceeds 8 MiB.');
        files.push({ path: match[3]!, content: blob.stdout.toString('base64'), encoding: 'base64' as const });
      }
      return new SkillPackageDraft({
        name: basename(source.directory || source.url.replace(/\.git$/u, '')),
        source: `${source.url}@${revision}${source.directory ? `:${source.directory}` : ''}`,
        files,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
