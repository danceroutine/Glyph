import type { WorkspacePathAccess } from './WorkspacePathAccess.ts';
import { WorkspaceTextDecodingError } from './WorkspaceTextDecodingError.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from './WorkspaceTextStore.ts';
import { WorkspaceMutationConsistency } from './WorkspaceMutationConsistency.ts';
import { WorkspaceRootAccess } from './policy/WorkspaceRootAccess.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';
import type { WorkspaceReadOptions } from './WorkspaceReadOptions.ts';
import { WorkspaceReadLimitError } from './WorkspaceReadLimitError.ts';
import { assertWellFormedWorkspacePath } from './assertWellFormedWorkspacePath.ts';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';

/** A revocable disk write stages its bytes and checks the initiating command immediately before publication. */
type DiskPublicationOptions = WorkspaceMutationOptions & { readonly signal?: AbortSignal };

const fileSystemWorkspaceTextStoreOptionsSchema = z
  .object({
    access: z.instanceof(WorkspaceRootAccess),
    physicalAccess: z.custom<WorkspacePathAccess>(
      value =>
        typeof value === 'object' &&
        value !== null &&
        'assertWorkspacePath' in value &&
        typeof value.assertWorkspacePath === 'function',
    ),
  })
  .strict();

/**
 * Performs workspace reads and revision-checked disk mutations through the selected root's access policy.
 * A window can supply its command signal when publishing a personal rule. The store stages revocable creates
 * and checks the signal at the filesystem call that makes a creation, replacement, or removal visible.
 */
export class FileSystemWorkspaceTextStore implements WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  readonly mutationConsistency = WorkspaceMutationConsistency.BEST_EFFORT_FILESYSTEM;
  private readonly options: z.output<typeof fileSystemWorkspaceTextStoreOptionsSchema>;

  constructor(root: string, options: z.input<typeof fileSystemWorkspaceTextStoreOptionsSchema>) {
    assertWellFormedWorkspacePath(root);
    this.root = resolve(root);
    this.options = fileSystemWorkspaceTextStoreOptionsSchema.parse(options);
    if (resolve(this.options.access.root) !== this.root)
      throw new Error('Workspace authority belongs to a different root.');
    this.caseSensitive = this.options.access.caseSensitive;
  }

  /** Hold this guard across an editor request or other composite read. Check before publishing or delivering its result. */
  beginOperation() {
    return this.options.access.beginOperation();
  }

  normalizePath(input: string): string {
    const normalized = normalizeProjectPath(this.root, input);
    let path = this.root;
    if (
      this.options.access.beginOperation().privateRoot ||
      normalized.split('/').some(part => {
        path = join(path, part);
        return this.isIgnoredDirectory(part, path);
      }) ||
      this.isExcluded(normalized)
    ) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'That path is excluded from project access.', {
        path: normalized,
      });
    }
    return normalized;
  }

  async canonicalPath(input: string): Promise<string> {
    const key = (await this.resolvePath(input)).split(sep).join('/');
    return this.caseSensitive ? key : key.toLocaleLowerCase('en-US');
  }

  /** Authorized physical path with the spelling required by filesystem operations. */
  async resolvePath(input: string): Promise<string> {
    const operation = this.options.access.beginOperation();
    const path = this.normalizePath(input);
    await this.assertNoSymlinkSegments(path, true);
    const root = await realpath(this.root);
    let cursor = resolve(this.root, path);
    const missing: string[] = [];
    for (;;) {
      try {
        // Canonicalize the nearest existing ancestor so aliases also collide
        // before a new file (or its parent directories) has been created.
        const existing = await realpath(cursor);
        const canonical = resolve(existing, ...missing);
        assertInsideRoot(root, canonical, path);
        await this.assertPhysicalAccess(canonical);
        this.normalizePath(relative(root, canonical));
        operation.assertCurrent();
        return canonical;
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT' || cursor === this.root) {
          throw classifyPathError(error, path);
        }
        missing.unshift(basename(cursor));
        cursor = dirname(cursor);
      }
    }
  }

  /** Admit one directory for an index or filesystem listing, including the attached root. */
  async inspectDirectory(targetDirectory?: string): Promise<{ root: string; searchRoot: string }> {
    const operation = this.beginOperation();
    if (operation.privateRoot)
      throw new EditError(EditFailureReason.UNSUPPORTED, 'That directory is excluded from project access.');
    const root = await realpath(this.root);
    const normalizedTarget = targetDirectory === undefined ? undefined : this.normalizePath(targetDirectory);
    if (normalizedTarget !== undefined && normalizedTarget !== '')
      await this.assertNoSymlinkSegments(normalizedTarget, false);
    const searchRoot =
      normalizedTarget !== undefined && normalizedTarget !== '' ? resolve(root, normalizedTarget) : root;
    await this.assertPhysicalAccess(searchRoot);
    const searchRootInfo = await lstat(searchRoot);
    if (!searchRootInfo.isDirectory()) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'The target directory is not a directory.', {
        path: normalizedTarget ?? '.',
      });
    }
    operation.assertCurrent();
    return { root, searchRoot };
  }

  /** Standalone disk enumeration for callers without a native catalog. Production tool and catalog queries use the
   * root's shared native index to apply ignore rules and avoid a filesystem inspection process for each entry. */
  async list(
    maxFiles: number,
    globPattern = '**/*',
    targetDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const operation = this.options.access.beginOperation();
    signal?.throwIfAborted();
    if (operation.privateRoot) return { files: [], truncated: false };
    const { root, searchRoot } = await this.inspectDirectory(targetDirectory);
    const normalizedPattern = globPattern.startsWith('**/') ? globPattern : `**/${globPattern}`;
    const matchPattern = this.caseSensitive ? normalizedPattern : normalizedPattern.toLowerCase();
    const files: string[] = [];
    let truncated = false;
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        try {
          await this.assertPhysicalAccess(absolute);
        } catch {
          continue;
        }
        const path = relative(root, absolute).split(sep).join('/');
        if (entry.isDirectory()) {
          if (!this.isIgnoredDirectory(entry.name, absolute) && !this.isExcludedPath(path)) await visit(absolute);
          if (truncated) return;
        } else if (entry.isFile()) {
          const pathWithinTarget = relative(searchRoot, absolute).split(sep).join('/');
          const matchCandidate = this.caseSensitive ? pathWithinTarget : pathWithinTarget.toLowerCase();
          if (
            !this.isIgnoredDirectory(entry.name, absolute) &&
            !this.isExcluded(path) &&
            matchesGlob(matchCandidate, matchPattern)
          ) {
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
    operation.assertCurrent();
    signal?.throwIfAborted();
    return { files, truncated };
  }

  async read(input: string, options: WorkspaceReadOptions = {}): Promise<WorkspaceTextSnapshot> {
    const snapshot = await this.readBytes(input, options);
    return toSnapshot(snapshot.path, snapshot.bytes, snapshot.mode, snapshot.identity, snapshot.revision);
  }

  /** Read bounded binary assets through the same policy, identity, and no-symlink checks as text. */
  async readBytes(
    input: string,
    options: WorkspaceReadOptions = {},
  ): Promise<{ path: string; bytes: Buffer; mode: number; identity: string; revision: string }> {
    const operation = this.options.access.beginOperation();
    const { path, resolvedFile, identity } = await this.inspectReadPath(input, options.interruptedRename);
    // Inspection and open are separate operations. Do not follow a replacement
    // link or block opening a replacement FIFO before descriptor validation.
    const flags =
      process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let handle: FileHandle;
    try {
      handle = await open(resolvedFile, flags);
    } catch (error) {
      if (errorCodeOf(error) === 'ELOOP') {
        throw new EditError(
          EditFailureReason.UNSUPPORTED,
          'Symbolic links are not supported.',
          { path },
          { cause: error },
        );
      }
      throw classifyPathError(error, path);
    }
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) {
        throw new EditError(EditFailureReason.UNSUPPORTED, 'Path does not refer to a regular file.', { path });
      }
      assertAllowedLinks(Number(info.nlink), identity, path, options.interruptedRename);
      if (`${info.dev}:${info.ino}` !== identity) {
        throw new EditError(EditFailureReason.STALE, 'The file changed while opening it for reading.', { path });
      }
      await this.assertPhysicalAccess(resolvedFile, handle);
      // Keep loading bound to the same validated descriptor even if the path is
      // renamed again. A snapshot's mode and identity describe these bytes.
      const bytes =
        options.maxBytes === undefined
          ? await handle.readFile()
          : await this.readBounded(handle, path, options.maxBytes, Number(info.size));
      await this.assertPhysicalAccess(resolvedFile, handle);
      const revision = createHash('sha256').update(bytes).digest('hex');
      if (info.nlink !== 1n && revision !== options.interruptedRename!.revision) {
        throw new EditError(EditFailureReason.STALE, 'The interrupted rename no longer contains the reviewed bytes.', {
          path,
        });
      }
      options.retainAccess?.(operation.assertCurrent);
      return {
        path,
        bytes,
        mode: Number(info.mode) & 0o777,
        identity,
        revision,
      };
    } finally {
      await handle.close();
      operation.assertCurrent();
    }
  }

  /** Collision checks need path metadata, never a decoded text snapshot. */
  async exists(input: string): Promise<boolean> {
    const path = this.normalizePath(input);
    try {
      await this.assertPhysicalAccess(resolve(this.root, path));
      await this.assertNoSymlinkSegments(path, false);
      const resolvedRoot = await realpath(this.root);
      const resolvedPath = await realpath(resolve(this.root, path));
      assertInsideRoot(resolvedRoot, resolvedPath, path);
      this.normalizePath(relative(resolvedRoot, resolvedPath));
      await this.assertPhysicalAccess(resolvedPath);
      return true;
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return false;
      throw classifyPathError(error, path);
    }
  }

  /** Enforces disk access policy without loading stale content ahead of an authoritative editor read. */
  async validateAccess(input: string): Promise<void> {
    await this.assertPhysicalAccess(resolve(this.root, this.normalizePath(input)));
    try {
      await this.inspectReadPath(input);
    } catch (error) {
      // A live editor may own a new, unsaved file. Ancestor and exclusion checks
      // still run before a missing path is allowed through to the editor.
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    }
  }

  async readOptional(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceTextSnapshot | undefined> {
    try {
      return await this.read(path, options);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return undefined;
      throw classifyPathError(error, path);
    }
  }

  async create(
    input: string,
    text: string,
    byteOrderMark: boolean,
    mode = 0o644,
    options?: DiskPublicationOptions & { readonly inspectBeforeWrite?: (file: FileHandle) => Promise<void> },
  ): Promise<WorkspaceTextSnapshot> {
    const operation = this.options.access.beginOperation();
    assertSupportedText(text, input);
    const path = this.normalizePath(input);
    await this.assertNoSymlinkSegments(path, true);
    const absolute = resolve(this.root, path);
    await this.assertPhysicalAccess(absolute);
    const created = await this.createParents(dirname(absolute), operation.assertCurrent);
    try {
      if (options?.inspectBeforeWrite || options?.signal) {
        // Inherit metadata from the destination directory, admit the empty inode, then publish without overwriting.
        const staged = resolve(dirname(absolute), `.${randomUUID()}.glyph.tmp`);
        const handle = await open(staged, 'wx', mode);
        try {
          const identity = await handle.stat({ bigint: true });
          const ownsStagedEntry = async () => {
            const entry = await lstat(staged, { bigint: true }).catch(error => {
              if (errorCodeOf(error) === 'ENOENT') return undefined;
              throw error;
            });
            return entry?.dev === identity.dev && entry.ino === identity.ino;
          };
          try {
            await handle.chmod(mode);
            await options.inspectBeforeWrite?.(handle);
            operation.assertCurrent();
            await handle.writeFile(toBytes(text, byteOrderMark));
            await options.beforePublish?.();
            if (!(await ownsStagedEntry())) throw new Error('The staged create file changed before publication.');
            await this.assertPhysicalAccess(absolute);
            operation.assertCurrent();
            options.signal?.throwIfAborted();
            await link(staged, absolute);
          } finally {
            if (await ownsStagedEntry()) await unlink(staged);
          }
        } finally {
          await handle.close();
        }
      } else {
        await options?.beforePublish?.();
        await this.assertPhysicalAccess(absolute);
        operation.assertCurrent();
        const handle = await open(absolute, 'wx', mode);
        try {
          await this.assertPhysicalAccess(absolute, handle);
          await handle.chmod(mode);
          operation.assertCurrent();
          await handle.writeFile(toBytes(text, byteOrderMark));
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      await rollbackDirectories(created);
      if (errorCodeOf(error) === 'EEXIST') {
        throw new EditError(
          EditFailureReason.STALE,
          'The create target now exists.',
          { path, retry: 'Read the target and submit a new proposal.' },
          { cause: error },
        );
      }
      throw classifyPathError(error, path);
    }
    return this.read(path);
  }

  async replace(
    input: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: DiskPublicationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    const operation = this.options.access.beginOperation();
    // POSIX filesystems do not expose compare-and-swap replacement by content
    // revision. The second check narrows, but cannot eliminate, the interval in
    // which a non-cooperating external writer can be overwritten by rename(2).
    assertSupportedText(text, input);
    const path = this.normalizePath(input);
    const current = await this.assertRevision(path, expectedRevision);
    const absolute = resolve(this.root, path);
    const temporary = resolve(dirname(absolute), `.${randomUUID()}.glyph.tmp`);
    try {
      await this.assertPhysicalAccess(absolute);
      operation.assertCurrent();
      await writeFile(temporary, toBytes(text, byteOrderMark), { flag: 'wx', mode: current.mode });
      await chmod(temporary, current.mode);
      await this.assertRevision(path, expectedRevision);
      const [source, staged] = await Promise.all([lstat(absolute), lstat(temporary)]);
      if (source.uid !== staged.uid || source.gid !== staged.gid || (source.mode & 0o7777) !== (staged.mode & 0o7777))
        throw new EditError(
          EditFailureReason.UNSUPPORTED,
          'Replacement cannot preserve the existing ownership and permissions.',
          { path },
        );
      await options?.beforeReplace?.(temporary);
      await this.assertPhysicalAccess(absolute);
      operation.assertCurrent();
      options?.signal?.throwIfAborted();
      await rename(temporary, absolute);
    } catch (error) {
      throw classifyPathError(error, path);
    } finally {
      await unlink(temporary).catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes(errorCodeOf(error) ?? '')) throw error;
      });
    }
    return this.read(path);
  }

  async rename(sourceInput: string, targetInput: string, expectedRevision: string): Promise<WorkspaceTextSnapshot> {
    const operation = this.options.access.beginOperation();
    const source = this.normalizePath(sourceInput);
    const target = this.normalizePath(targetInput);
    await this.assertRevision(source, expectedRevision);
    await this.assertNoSymlinkSegments(target, true);
    if (await this.exists(target)) {
      throw new EditError(EditFailureReason.STALE, 'The rename target now exists.', {
        path: target,
        retry: 'Choose a different target or submit a new proposal.',
      });
    }
    await this.assertPhysicalAccess(resolve(this.root, target));
    const created = await this.createParents(dirname(resolve(this.root, target)), operation.assertCurrent);
    try {
      await this.assertRevision(source, expectedRevision);
      // link(2) is exclusive at the target, unlike rename(2), which would
      // silently overwrite a collaborator-created target on POSIX.
      await this.assertPhysicalAccess(resolve(this.root, source));
      await this.assertPhysicalAccess(resolve(this.root, target));
      operation.assertCurrent();
      await link(resolve(this.root, source), resolve(this.root, target));
      await unlink(resolve(this.root, source));
    } catch (error) {
      await rollbackDirectories(created);
      if (errorCodeOf(error) === 'EEXIST') {
        throw new EditError(
          EditFailureReason.STALE,
          'The rename target now exists.',
          { path: target },
          { cause: error },
        );
      }
      throw classifyPathError(error, target);
    }
    return this.read(target);
  }

  async delete(input: string, expectedRevision: string, options?: DiskPublicationOptions): Promise<void> {
    const operation = this.options.access.beginOperation();
    const path = this.normalizePath(input);
    await this.assertRevision(path, expectedRevision, options);
    await options?.beforePublish?.();
    try {
      await this.assertPhysicalAccess(resolve(this.root, path));
      operation.assertCurrent();
      options?.signal?.throwIfAborted();
      await unlink(resolve(this.root, path));
    } catch (error) {
      throw classifyPathError(error, path);
    }
  }

  private async assertPhysicalAccess(absolute: string, handle?: FileHandle): Promise<void> {
    const access = this.options.access.beginOperation();
    await this.options.physicalAccess.assertWorkspacePath(
      absolute,
      access.privatePaths,
      handle ? { handle } : undefined,
    );
    access.assertCurrent();
  }

  private async inspectReadPath(input: string, checkpoint?: WorkspaceReadOptions['interruptedRename']) {
    const path = this.normalizePath(input);
    try {
      await this.assertNoSymlinkSegments(path, false);
      const absolute = resolve(this.root, path);
      const linkStat = await lstat(absolute, { bigint: true });
      if (linkStat.isSymbolicLink())
        throw new EditError(EditFailureReason.UNSUPPORTED, 'Symbolic links are not supported.', { path });
      if (!linkStat.isFile())
        throw new EditError(EditFailureReason.UNSUPPORTED, 'Path does not refer to a regular file.', { path });
      const resolvedRoot = await realpath(this.root);
      const identity = `${linkStat.dev}:${linkStat.ino}`;
      assertAllowedLinks(Number(linkStat.nlink), identity, path, checkpoint);
      const resolvedFile = await realpath(absolute);
      assertInsideRoot(resolvedRoot, resolvedFile, path);
      // Check the filesystem's spelling too: aliases must not bypass the policy.
      this.normalizePath(relative(resolvedRoot, resolvedFile));
      return { path, resolvedFile, identity };
    } catch (error) {
      // An ancestor can change after its earlier inspection. Preserve that as
      // an unsupported resource, never as proof of an absent child or a delete.
      throw classifyPathError(error, path);
    }
  }

  private async readBounded(handle: FileHandle, path: string, maxBytes: number, size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Read budget must be a non-negative integer.');
    if (size > maxBytes) throw new WorkspaceReadLimitError(path, maxBytes, size);
    // A file can grow after stat. Read at most one byte beyond the budget,
    // never an unbounded readFile followed by a post-allocation size check.
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - length + 1));
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) return Buffer.concat(chunks, length);
      length += bytesRead;
      if (length > maxBytes) throw new WorkspaceReadLimitError(path, maxBytes, length, length);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    throw new WorkspaceReadLimitError(path, maxBytes, length, length);
  }

  private async assertRevision(
    path: string,
    expected: string,
    options?: WorkspaceReadOptions,
  ): Promise<WorkspaceTextSnapshot> {
    const current = await this.readOptional(path, options);
    if (!current || current.revision !== expected) {
      throw new EditError(EditFailureReason.STALE, 'The file changed after the proposal was staged.', {
        path,
        ...(current ? { currentRevision: current.revision } : {}),
        retry: 'Read the current file and submit a new proposal.',
      });
    }
    return current;
  }

  private async createParents(directory: string, assertCurrent: () => void): Promise<string[]> {
    const missing: string[] = [];
    let cursor = directory;
    while (cursor !== this.root) {
      try {
        const info = await stat(cursor);
        if (!info.isDirectory())
          throw new EditError(EditFailureReason.UNSUPPORTED, 'A parent path is not a directory.');
        break;
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') {
          throw classifyPathError(error, relative(this.root, directory));
        }
        missing.push(cursor);
        cursor = dirname(cursor);
      }
    }
    const created = missing.toReversed();
    for (const path of created) {
      try {
        await this.assertPhysicalAccess(path);
        assertCurrent();
        await mkdir(path);
      } catch (error) {
        throw classifyPathError(error, relative(this.root, path));
      }
    }
    return created;
  }

  private async assertNoSymlinkSegments(path: string, allowMissing: boolean): Promise<void> {
    let cursor = this.root;
    const segments = path.split('/');
    for (const [index, part] of segments.entries()) {
      cursor = resolve(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) {
          throw new EditError(EditFailureReason.UNSUPPORTED, 'Symbolic links are not supported.', { path });
        }
        // Only the leaf may be a file. Returning "missing" for a child of a
        // regular file would authorize an impossible CREATE or editor read.
        if (index < segments.length - 1 && !info.isDirectory()) {
          throw new EditError(EditFailureReason.UNSUPPORTED, 'A parent path is not a directory.', { path });
        }
      } catch (error) {
        if (allowMissing && errorCodeOf(error) === 'ENOENT') return;
        throw classifyPathError(error, path);
      }
    }
  }

  private isExcluded(path: string): boolean {
    if (this.isExcludedPath(path)) return true;
    return this.options.access.policy.isSensitiveFileName(path.split('/').at(-1) ?? '', this.caseSensitive);
  }

  private isIgnoredDirectory(name: string, path: string): boolean {
    return this.options.access.policy.isIgnoredDirectory(name, this.caseSensitive, path, true);
  }

  private isExcludedPath(path: string): boolean {
    return this.options.access
      .beginOperation()
      .excludedPaths.some(excluded => path === excluded || path.startsWith(`${excluded}/`));
  }
}

function normalizeProjectPath(root: string, input: string): string {
  assertWellFormedWorkspacePath(input);
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

/** ENOTDIR is inaccessible hierarchy, not evidence that a reviewed child was deleted. */
function classifyPathError(error: unknown, path: string): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOTDIR') return error;
  return new EditError(EditFailureReason.UNSUPPORTED, 'A parent path is not a directory.', { path }, { cause: error });
}

function assertAllowedLinks(
  count: number,
  identity: string,
  path: string,
  checkpoint?: WorkspaceReadOptions['interruptedRename'],
): void {
  if (count !== 1 && !(count === 2 && checkpoint?.identity === identity))
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Unverified hard links are excluded from project access.', {
      path,
    });
}

function toSnapshot(
  path: string,
  bytes: Buffer,
  mode: number,
  identity: string,
  revision = createHash('sha256').update(bytes).digest('hex'),
): WorkspaceTextSnapshot {
  if (bytes.includes(0))
    throw new WorkspaceTextDecodingError(path, 'Binary/NUL files are not supported.', bytes.length);
  const byteOrderMark = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = byteOrderMark ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    // The encoding marker was removed above; a second U+FEFF is document text.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch (error) {
    throw new WorkspaceTextDecodingError(path, 'File is not valid UTF-8.', bytes.length, { cause: error });
  }
  return {
    path,
    text,
    byteOrderMark,
    revision,
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

/** Reject unsupported bytes before creating directories or opening a write handle. */
function assertSupportedText(text: string, path: string): void {
  if (text.includes('\0'))
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Binary/NUL files are not supported.', { path });
  // In Unicode mode valid pairs are one code point and do not match. UTF-8
  // encoding must never silently replace a reviewed lone surrogate with U+FFFD.
  if (/[\uD800-\uDFFF]/u.test(text)) {
    throw new EditError(EditFailureReason.UNSUPPORTED, 'Text contains an unpaired UTF-16 surrogate.', { path });
  }
}

async function rollbackDirectories(paths: string[]): Promise<void> {
  for (const path of paths.toReversed()) {
    try {
      await rmdir(path);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(errorCodeOf(error) ?? '')) throw error;
    }
  }
}
