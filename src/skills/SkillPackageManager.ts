import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import type { SkillStateStore } from './SkillStateStore.ts';
import type { SkillPreview, SkillPreviewFile } from './SkillLifecycle.ts';
import { SkillPackageDraft } from './SkillPackageDraft.ts';

export interface SkillPackageLocation {
  readonly id: string;
  readonly label: string;
  readonly store: FileSystemWorkspaceTextStore;
  readonly workspace: WorkspaceTextStore;
  readonly directory: string;
  readonly listFiles: () => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  readonly refreshIndex: () => Promise<void>;
}
interface Pending {
  readonly preview: SkillPreview;
  readonly location: SkillPackageLocation;
  readonly directory: string;
  readonly draft?: SkillPackageDraft;
  readonly expected: string | undefined;
}
/** Revision-guarded package lifecycle. Staged directory swaps preserve the old package on validation or write failures. */
export class SkillPackageManager {
  private readonly pending = new Map<string, Pending>();
  private queue = Promise.resolve();
  constructor(
    private readonly locations: readonly SkillPackageLocation[],
    private readonly catalog: SkillCatalog,
    private readonly state: SkillStateStore,
  ) {}
  get targets() {
    return this.locations.map(location => ({
      id: location.id,
      label: location.label,
      uri: pathToFileURL(join(location.store.root, location.directory)).toString(),
    }));
  }
  async prepare(targetId: string, draft: SkillPackageDraft, replaceId?: string): Promise<SkillPreview> {
    const location = this.location(targetId);
    const existing = replaceId ? this.catalog.skills.find(skill => skill.id === replaceId) : undefined;
    if (replaceId && (!existing || existing.origin.id !== targetId || existing.name !== draft.name))
      throw new Error('The update must target the selected installed skill.');
    const directory = existing?.directory ?? `${location.directory}/${draft.name}`;
    for (const path of draft.files().keys()) location.store.normalizePath(`${directory}/${path}`);
    const before = await this.read(location, directory);
    if (!replaceId && (before.size > 0 || (await location.store.exists(directory))))
      throw new Error('A skill already occupies this destination. Select Update.');
    if (replaceId && before.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, directory, before, draft);
  }
  async prepareRemoval(id: string): Promise<SkillPreview> {
    const descriptor = this.catalog.skills.find(skill => skill.id === id);
    if (!descriptor) throw new Error('Skill is unavailable.');
    const location = this.location(descriptor.origin.id);
    return this.remember(location, descriptor.directory, await this.read(location, descriptor.directory));
  }
  discard(id: string): void {
    this.pending.delete(id);
  }
  apply(id: string, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    const selected = this.pending.get(id);
    if (!selected) return Promise.reject(new Error('Skill preview expired. Preview the change again.'));
    this.pending.delete(id);
    const operation = this.queue.then(() => this.commit(selected, signal));
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.catalog.skills.some(skill => skill.id === id)) throw new Error('Skill is unavailable.');
    await this.state.setEnabled(id, enabled);
    await this.catalog.refresh();
  }
  private location(id: string) {
    const location = this.locations.find(candidate => candidate.id === id);
    if (!location) throw new Error('This skill location cannot be managed.');
    return location;
  }
  private remember(
    location: SkillPackageLocation,
    directory: string,
    before: ReadonlyMap<string, Uint8Array>,
    draft?: SkillPackageDraft,
  ): SkillPreview {
    const after = draft?.files() ?? new Map<string, Uint8Array>();
    const files: SkillPreviewFile[] = [...new Set([...before.keys(), ...after.keys()])].toSorted().map(path => ({
      path,
      ...(before.has(path) ? { before: display(before.get(path)!) } : {}),
      ...(after.has(path) ? { after: display(after.get(path)!) } : {}),
    }));
    const preview: SkillPreview = {
      id: randomUUID(),
      action: draft ? (before.size > 0 ? 'update' : 'install') : 'remove',
      targetId: location.id,
      name: posix.basename(directory),
      source: draft?.source ?? 'Installed package',
      revision: draft?.revision ?? fingerprint(before),
      files,
    };
    while (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(preview.id, {
      preview,
      location,
      directory,
      expected: before.size > 0 ? fingerprint(before) : undefined,
      ...(draft ? { draft } : {}),
    });
    return structuredClone(preview);
  }
  private async read(location: SkillPackageLocation, directory: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const normalized = location.store.normalizePath(directory);
    if (
      normalized !== directory ||
      !(directory.startsWith(`${location.directory}/`) || directory.includes(`/${location.directory}/`))
    )
      throw new Error('Skill directory is outside its managed location.');
    const listed = await location.listFiles();
    if (listed.truncated) throw new Error('Skill catalog is incomplete.');
    const paths = listed.files.filter(path => path.startsWith(`${directory}/`));
    if (paths.length > 256) throw new Error('Skill package exceeds 256 files.');
    const inventory = await inventoryFiles(join(location.store.root, directory));
    if (inventory.length !== paths.length || inventory.some(path => !paths.includes(`${directory}/${path}`)))
      throw new Error('Package contains unindexed or unauthorized files. Refresh before managing it.');
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const path of paths) {
      const raw = await location.store.readBytes(path, { maxBytes: 1024 * 1024 });
      total += raw.bytes.byteLength;
      if (total > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
      let utf8 = false;
      try {
        new TextDecoder('utf8', { fatal: true }).decode(raw.bytes);
        utf8 = !raw.bytes.includes(0);
      } catch {
        /* Binary assets have no text model. */
      }
      if (utf8) {
        const live = await location.workspace.read(path, { maxBytes: 1024 * 1024 });
        if (live.revision !== raw.revision) throw new Error('Save skill edits before managing the package.');
      }
      files.set(posix.relative(directory, path), raw.bytes);
    }
    return files;
  }
  private async commit(change: Pending, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    signal?.throwIfAborted();
    const { location, directory, draft } = change;
    await location.refreshIndex();
    const current = await this.read(location, directory);
    if ((current.size > 0 ? fingerprint(current) : undefined) !== change.expected)
      throw new Error('The skill changed after preview. Preview it again.');
    const target = await location.store.canonicalPath(directory);
    await mkdir(dirname(target), { recursive: true });
    const stagingRoot = await location.store.canonicalPath(`.skill-staging/${randomUUID()}`);
    await mkdir(stagingRoot, { recursive: true });
    const backup = join(stagingRoot, 'previous');
    const staged = join(stagingRoot, 'package');
    let moved = false;
    let preserveBackup = false;
    try {
      if (draft) {
        await mkdir(staged);
        for (const [path, bytes] of draft.files()) {
          signal?.throwIfAborted();
          const file = join(staged, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes, { flag: 'wx', mode: 0o644 });
        }
      }
      signal?.throwIfAborted();
      if (change.expected) {
        await rename(target, backup);
        moved = true;
        const saved = new FileSystemWorkspaceTextStore(backup);
        const movedFiles = new Map<string, Uint8Array>();
        for (const path of await inventoryFiles(backup))
          movedFiles.set(path, (await saved.readBytes(path, { maxBytes: 1024 * 1024 })).bytes);
        if (fingerprint(movedFiles) !== change.expected)
          throw new Error('The skill changed during replacement. Preview it again.');
      } else if (
        await lstat(target).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        )
      )
        throw new Error('A skill appeared at the destination. Preview again.');
      if (draft) await rename(staged, target);
      try {
        if (draft) await this.state.record(`${location.id}:${directory}`, draft.source, draft.revision);
        else await this.state.forget(`${location.id}:${directory}`);
      } catch (error) {
        if (draft) {
          const saved = new FileSystemWorkspaceTextStore(target);
          const actual = new Map<string, Uint8Array>();
          for (const path of await inventoryFiles(target))
            actual.set(path, (await saved.readBytes(path, { maxBytes: 1024 * 1024 })).bytes);
          if (fingerprint(actual) !== draft.revision) {
            preserveBackup = true;
            moved = false;
            throw new Error(`Installed files changed during recovery. Preserved backups at ${backup}.`, {
              cause: error,
            });
          }
          await rm(target, { recursive: true, force: true });
        }
        throw error;
      }
    } catch (error) {
      // A failed filesystem acknowledgement can follow a completed rename.
      // Inspect retained originals before releasing any staging resources.
      if (change.expected && !moved && !preserveBackup) {
        try {
          moved = await lstat(backup).then(
            () => true,
            (failure: NodeJS.ErrnoException) => {
              if (failure.code === 'ENOENT') return false;
              throw failure;
            },
          );
        } catch (inspectionError) {
          preserveBackup = true;
          throw new Error(`Package recovery is required. Inspect retained staging at ${stagingRoot}.`, {
            cause: inspectionError,
          });
        }
      }
      if (moved) {
        try {
          await rename(backup, target);
          moved = false;
        } catch (restoreError) {
          preserveBackup = true;
          throw new Error(`Package recovery is required. The previous package is preserved at ${backup}.`, {
            cause: restoreError,
          });
        }
      }
      throw error;
    } finally {
      if (!preserveBackup) await rm(stagingRoot, { recursive: true, force: true });
    }
    try {
      await location.refreshIndex();
      await this.catalog.refresh();
      return { applied: true };
    } catch {
      return {
        applied: true,
        refreshError: 'The package was changed successfully. Refresh Skills to update the catalog.',
      };
    }
  }
}
function fingerprint(files: ReadonlyMap<string, Uint8Array>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...files]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]),
      ),
    )
    .digest('hex');
}
function display(bytes: Uint8Array): string {
  try {
    if (!bytes.includes(0)) return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    /* Binary resource. */
  }
  return `[Binary resource: ${bytes.byteLength} bytes]`;
}

/** Bounded transaction inventory detects files excluded by discovery, so a directory swap cannot discard unseen data. */
async function inventoryFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Skill package nesting exceeds 32 levels.');
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && prefix === '') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error('Skill packages cannot contain symlinks or special files.');
      if (entry.isDirectory()) await visit(join(directory, entry.name), path, depth + 1);
      else {
        result.push(path);
        if (result.length > 256) throw new Error('Skill package exceeds 256 files.');
      }
    }
  };
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()))
    throw new Error('Skill package must be a real directory.');
  await visit(root, '', 0);
  return result;
}
