import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { EditError } from '../editing/errors/EditError.ts';
import { EditFailureReason } from '../editing/errors/EditFailureReason.ts';
import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from './WorkspaceTextStore.ts';
import { WorkspaceMutationConsistency } from './WorkspaceMutationConsistency.ts';

const fileSystemWorkspaceTextStoreOptionsSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    ignoredDirectories: z.array(z.string()).default(['.git', '.next', 'coverage', 'dist', 'node_modules', 'target']),
    excludedPaths: z.array(z.string().min(1)).default([]),
    sensitiveFileNames: z.array(z.string()).default(['.netrc', '.npmrc', '.pypirc']),
    sensitiveFilePrefixes: z.array(z.string()).default(['.env']),
    sensitiveFileExtensions: z.array(z.string()).default(['.key', '.pem', '.p12', '.pfx']),
    allowedFileNames: z.array(z.string()).default(['.env.example']),
  })
  .strict();

type FileSystemWorkspaceTextStoreOptions = z.input<typeof fileSystemWorkspaceTextStoreOptionsSchema>;
type ResolvedOptions = Omit<z.output<typeof fileSystemWorkspaceTextStoreOptionsSchema>, 'caseSensitive'>;

export class FileSystemWorkspaceTextStore implements WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  readonly mutationConsistency = WorkspaceMutationConsistency.BEST_EFFORT_FILESYSTEM;
  private readonly options: ResolvedOptions;

  constructor(root: string, options: FileSystemWorkspaceTextStoreOptions = {}) {
    const {
      caseSensitive,
      ignoredDirectories,
      excludedPaths,
      sensitiveFileNames,
      sensitiveFilePrefixes,
      sensitiveFileExtensions,
      allowedFileNames,
    } = fileSystemWorkspaceTextStoreOptionsSchema.parse(options);
    this.root = resolve(root);
    this.caseSensitive = caseSensitive ?? (process.platform !== 'win32' && process.platform !== 'darwin');
    this.options = {
      ignoredDirectories,
      excludedPaths: [...new Set(excludedPaths.map(path => normalizeProjectPath(this.root, path)))],
      sensitiveFileNames,
      sensitiveFilePrefixes,
      sensitiveFileExtensions,
      allowedFileNames,
    };
  }

  normalizePath(input: string): string {
    const normalized = normalizeProjectPath(this.root, input);
    if (
      normalized.split('/').some(part => this.options.ignoredDirectories.includes(part)) ||
      this.isExcluded(normalized)
    ) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'That path is excluded from project access.', {
        path: normalized,
      });
    }
    return normalized;
  }

  async list(
    maxFiles: number,
    globPattern = '**/*',
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const root = await realpath(this.root);
    const normalizedTarget = targetDirectory === undefined ? undefined : this.normalizePath(targetDirectory);
    if (normalizedTarget) await this.assertNoSymlinkSegments(normalizedTarget, false);
    const searchRoot = normalizedTarget ? resolve(root, normalizedTarget) : root;
    const searchRootInfo = await lstat(searchRoot);
    if (!searchRootInfo.isDirectory()) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'The target directory is not a directory.', {
        path: normalizedTarget ?? '.',
      });
    }
    const normalizedPattern = globPattern.startsWith('**/') ? globPattern : `**/${globPattern}`;
    const matchPattern = this.caseSensitive ? normalizedPattern : normalizedPattern.toLowerCase();
    const files: string[] = [];
    let truncated = false;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        const path = relative(root, absolute).split(sep).join('/');
        if (entry.isDirectory()) {
          if (!this.options.ignoredDirectories.includes(entry.name) && !this.isExcludedPath(path))
            await visit(absolute);
          if (truncated) return;
        } else if (entry.isFile()) {
          const pathWithinTarget = relative(searchRoot, absolute).split(sep).join('/');
          const matchCandidate = this.caseSensitive ? pathWithinTarget : pathWithinTarget.toLowerCase();
          if (!this.isExcluded(path) && matchesGlob(matchCandidate, matchPattern)) {
            if (files.length === maxFiles) {
              truncated = true;
              return;
            }
            files.push(path);
          }
        }
      }
    };
    await visit(searchRoot);
    return { files, truncated };
  }

  async read(input: string): Promise<WorkspaceTextSnapshot> {
    const path = this.normalizePath(input);
    await this.assertNoSymlinkSegments(path, false);
    const absolute = resolve(this.root, path);
    const link = await lstat(absolute);
    if (link.isSymbolicLink())
      throw new EditError(EditFailureReason.UNSUPPORTED, 'Symbolic links are not supported.', { path });
    if (!link.isFile())
      throw new EditError(EditFailureReason.UNSUPPORTED, 'Path does not refer to a regular file.', { path });
    const resolvedRoot = await realpath(this.root);
    const resolvedFile = await realpath(absolute);
    assertInsideRoot(resolvedRoot, resolvedFile, path);
    const bytes = await readFile(resolvedFile);
    return toSnapshot(path, bytes, link.mode & 0o777, `${link.dev}:${link.ino}`);
  }

  async readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined> {
    try {
      return await this.read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async create(input: string, text: string, byteOrderMark: boolean, mode = 0o644): Promise<WorkspaceTextSnapshot> {
    const path = this.normalizePath(input);
    await this.assertNoSymlinkSegments(path, true);
    const absolute = resolve(this.root, path);
    const created = await this.createParents(dirname(absolute));
    try {
      const handle = await open(absolute, 'wx', mode);
      try {
        await handle.writeFile(toBytes(text, byteOrderMark));
      } finally {
        await handle.close();
      }
      await chmod(absolute, mode);
      return this.read(path);
    } catch (error) {
      await rollbackDirectories(created);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new EditError(
          EditFailureReason.STALE,
          'The create target now exists.',
          { path, retry: 'Read the target and submit a new proposal.' },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async replace(
    input: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
  ): Promise<WorkspaceTextSnapshot> {
    // POSIX filesystems do not expose compare-and-swap replacement by content
    // revision. The second check narrows, but cannot eliminate, the interval in
    // which a non-cooperating external writer can be overwritten by rename(2).
    const path = this.normalizePath(input);
    const current = await this.assertRevision(path, expectedRevision);
    const absolute = resolve(this.root, path);
    const temporary = resolve(dirname(absolute), `.${randomUUID()}.glyph.tmp`);
    try {
      await writeFile(temporary, toBytes(text, byteOrderMark), { flag: 'wx', mode: current.mode });
      await chmod(temporary, current.mode);
      await this.assertRevision(path, expectedRevision);
      await rename(temporary, absolute);
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    return this.read(path);
  }

  async rename(sourceInput: string, targetInput: string, expectedRevision: string): Promise<WorkspaceTextSnapshot> {
    const source = this.normalizePath(sourceInput);
    const target = this.normalizePath(targetInput);
    await this.assertRevision(source, expectedRevision);
    await this.assertNoSymlinkSegments(target, true);
    if (await this.readOptional(target)) {
      throw new EditError(EditFailureReason.STALE, 'The rename target now exists.', {
        path: target,
        retry: 'Choose a different target or submit a new proposal.',
      });
    }
    const created = await this.createParents(dirname(resolve(this.root, target)));
    try {
      await this.assertRevision(source, expectedRevision);
      // link(2) is exclusive at the target, unlike rename(2), which would
      // silently overwrite a collaborator-created target on POSIX.
      await link(resolve(this.root, source), resolve(this.root, target));
      await unlink(resolve(this.root, source));
      return this.read(target);
    } catch (error) {
      await rollbackDirectories(created);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new EditError(
          EditFailureReason.STALE,
          'The rename target now exists.',
          { path: target },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async delete(input: string, expectedRevision: string): Promise<void> {
    const path = this.normalizePath(input);
    await this.assertRevision(path, expectedRevision);
    await unlink(resolve(this.root, path));
  }

  private async assertRevision(path: string, expected: string): Promise<WorkspaceTextSnapshot> {
    const current = await this.readOptional(path);
    if (!current || current.revision !== expected) {
      throw new EditError(EditFailureReason.STALE, 'The file changed after the proposal was staged.', {
        path,
        ...(current ? { currentRevision: current.revision } : {}),
        retry: 'Read the current file and submit a new proposal.',
      });
    }
    return current;
  }

  private async createParents(directory: string): Promise<string[]> {
    const missing: string[] = [];
    let cursor = directory;
    while (cursor !== this.root) {
      try {
        const info = await stat(cursor);
        if (!info.isDirectory())
          throw new EditError(EditFailureReason.UNSUPPORTED, 'A parent path is not a directory.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(cursor);
        cursor = dirname(cursor);
      }
    }
    for (const path of missing.reverse()) await mkdir(path);
    return missing;
  }

  private async assertNoSymlinkSegments(path: string, allowMissing: boolean): Promise<void> {
    let cursor = this.root;
    for (const part of path.split('/')) {
      cursor = resolve(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) {
          throw new EditError(EditFailureReason.UNSUPPORTED, 'Symbolic links are not supported.', { path });
        }
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private isExcluded(path: string): boolean {
    if (this.isExcludedPath(path)) return true;
    const name = path.split('/').at(-1) ?? '';
    if (this.options.allowedFileNames.includes(name)) return false;
    return (
      this.options.sensitiveFileNames.includes(name) ||
      this.options.sensitiveFilePrefixes.some(prefix => name.startsWith(prefix)) ||
      this.options.sensitiveFileExtensions.some(extension => name.endsWith(extension))
    );
  }

  private isExcludedPath(path: string): boolean {
    const candidate = this.caseSensitive ? path : path.toLowerCase();
    return this.options.excludedPaths.some(excludedPath => {
      const excluded = this.caseSensitive ? excludedPath : excludedPath.toLowerCase();
      return candidate === excluded || candidate.startsWith(`${excluded}/`);
    });
  }
}

function normalizeProjectPath(root: string, input: string): string {
  if (!input || isAbsolute(input) || input.includes('\0')) {
    throw new EditError(EditFailureReason.MALFORMED, 'Path must be a non-empty project-relative path.', {
      path: input,
    });
  }
  const candidate = resolve(root, input);
  assertInsideRoot(root, candidate, input);
  const normalized = relative(root, candidate).split(sep).join('/');
  if (!normalized || normalized === '.') {
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Directory operations are not supported.', { path: input });
  }
  return normalized;
}

function toBytes(text: string, byteOrderMark: boolean): Buffer {
  const content = Buffer.from(text, 'utf8');
  return byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
}

function toSnapshot(path: string, bytes: Buffer, mode: number, identity: string): WorkspaceTextSnapshot {
  if (bytes.includes(0))
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Binary/NUL files are not supported.', { path });
  const byteOrderMark = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = byteOrderMark ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new EditError(EditFailureReason.UNSUPPORTED, 'File is not valid UTF-8.', { path }, { cause: error });
  }
  return {
    path,
    text,
    byteOrderMark,
    revision: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    mode,
    identity,
  };
}

function assertInsideRoot(root: string, candidate: string, path: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Path escapes the project root.', { path });
  }
}

async function rollbackDirectories(paths: string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    try {
      await rmdir(path);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}
