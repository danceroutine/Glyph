import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';
import { SkillProjectMutationPolicy } from './SkillProjectMutationPolicy.ts';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import { SkillPreferenceCommitUncertain, type SkillStateStore } from './SkillStateStore.ts';
import type { SkillPreview, SkillPreviewFile, SkillPreviewFileInfo } from './SkillLifecycle.ts';
import { SkillPackageDraft } from './SkillPackageDraft.ts';
import type { SkillPackageFile } from './SkillPackage.ts';
import { packageRevision } from './skillPackageRevision.ts';
import { skillPackageId } from './skillPackageId.ts';
import { inventoryFiles, readPackageFiles } from './skillPackageInventory.ts';
import { optionalStat, privateSkillDirectory, withSkillLock } from './SkillPackageStorage.ts';
import { SkillTransactionJournal, type SkillTransaction } from './SkillTransactionJournal.ts';

export interface SkillPackageLocation {
  readonly id: string;
  readonly label: string;
  readonly scope: 'user' | 'project';
  /** Workspace routing prefix for project packages in a multi-root window. */
  readonly scopePrefix?: string;
  readonly store: FileSystemWorkspaceTextStore;
  readonly workspace: WorkspaceTextStore;
  readonly mutations: WorkspaceDirectoryMutations;
  readonly directory: string;
  readonly listFiles: () => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  readonly refreshIndex: () => Promise<void>;
  readonly packageId?: (directory: string) => string;
  readonly assertClean?: (absolutePackageDirectory: string) => Promise<void>;
}
type PackageFiles = ReadonlyMap<string, SkillPackageFile>;
interface Pending {
  readonly preview: SkillPreview;
  readonly location: SkillPackageLocation;
  readonly directory: string;
  readonly files?: PackageFiles;
  readonly expected: string | null;
}

function textContent(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
function fileInfo(file: SkillPackageFile, text?: string): SkillPreviewFileInfo {
  return {
    size: file.bytes.length,
    digest: file.revision,
    mode: file.mode,
    encoding: text === undefined ? 'binary' : 'utf8',
  };
}
function compareFiles(before: PackageFiles, after: PackageFiles): SkillPreviewFile[] {
  return [...new Set([...before.keys(), ...after.keys()])].toSorted().map(path => {
    const old = before.get(path);
    const next = after.get(path);
    const a = old && textContent(old.bytes),
      b = next && textContent(next.bytes);
    return {
      path,
      status: !old
        ? 'added'
        : !next
          ? 'removed'
          : old.revision === next.revision && old.mode === next.mode
            ? 'unchanged'
            : 'modified',
      ...(old ? { beforeInfo: fileInfo(old, a) } : {}),
      ...(a === undefined ? {} : { before: a }),
      ...(next ? { afterInfo: fileInfo(next, b) } : {}),
      ...(b === undefined ? {} : { after: b }),
    };
  });
}
async function diskRevision(directory: string): Promise<string | null> {
  if (!(await optionalStat(directory))) return null;
  return packageRevision(await readPackageFiles(directory, await inventoryFiles(directory)));
}
async function packageDirectoryModes(target: string, files: PackageFiles, defaultMode: number) {
  const names = new Set(['']);
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) names.add(parts.slice(0, i).join('/'));
  }
  const modes = new Map<string, number>();
  for (const name of names) {
    // A draft can legitimately replace a file with a directory or vice versa.
    const stat = await optionalStat(join(target, name)).catch(error => {
      if (errorCodeOf(error) !== 'ENOTDIR') throw error;
      return undefined;
    });
    const parent = name.includes('/') ? posix.dirname(name) : '';
    modes.set(name, stat?.isDirectory() ? stat.mode & 0o777 : (modes.get(parent) ?? defaultMode));
  }
  return modes;
}

/** Stages immutable packages, serializes each destination and recovers interrupted publication before discovery. */
export class SkillPackageManager {
  readonly projectMutationPolicy: SkillProjectMutationPolicy;
  private readonly pending = new Map<string, Pending>();
  private readonly journal: SkillTransactionJournal;
  constructor(
    private readonly locations: readonly SkillPackageLocation[],
    private readonly catalog: SkillCatalog,
    private readonly state: SkillStateStore,
    private readonly ensureReady?: () => Promise<void>,
  ) {
    this.journal = new SkillTransactionJournal(state.userDirectory);
    this.projectMutationPolicy = new SkillProjectMutationPolicy(locations, catalog);
  }
  get targets() {
    return this.locations.map(location => ({
      id: location.id,
      scope: location.scope,
      label: location.label,
      uri: pathToFileURL(join(location.store.root, location.directory)).toString(),
    }));
  }
  async recover(originId?: string, directory?: string): Promise<void> {
    for (const location of this.locations) {
      if (originId !== undefined && location.id !== originId) continue;
      const root = await location.store.resolvePath(location.directory);
      if ((await this.journal.entries(root, location.id)).length > 0)
        await withSkillLock(location.store.root, 'destination', () => this.recoverLocation(location, root));
      if (directory) await this.checkPendingOrigin(location, await this.target(location, directory));
    }
  }
  async prepare(targetId: string, draft: SkillPackageDraft, replaceId?: string): Promise<SkillPreview> {
    if (this.ensureReady) await this.ensureReady();
    const location = this.location(targetId);
    await this.recover(location.id);
    const existing = replaceId ? this.catalog.skills.find(skill => skill.id === replaceId) : undefined;
    if (replaceId && (!existing?.directory || existing.origin.id !== targetId || existing.name !== draft.name))
      throw new Error('The update must target the selected installed skill.');
    const directory = existing?.directory ?? location.directory + '/' + draft.name;
    for (const path of draft.files().keys()) location.store.normalizePath(directory + '/' + path);
    const before = await this.read(location, directory);
    if (!replaceId && (before.size > 0 || (await location.store.exists(directory))))
      throw new Error('A skill already occupies this destination. Select Update.');
    if (replaceId && before.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, directory, before, draft);
  }
  async prepareRemoval(id: string): Promise<SkillPreview> {
    if (this.ensureReady) await this.ensureReady();
    const descriptor = this.catalog.skills.find(skill => skill.id === id);
    if (!descriptor?.directory || !descriptor.path) throw new Error('Skill is unavailable. Refresh Settings.');
    const location = this.location(descriptor.origin.id);
    await this.recover(location.id);
    const before = await this.read(location, descriptor.directory);
    if (before.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, descriptor.directory, before);
  }
  discard(id: string): void {
    this.pending.delete(id);
  }
  hasPreview(id: string): boolean {
    return this.pending.has(id);
  }
  /** The complete destination inventory can disclose scoped instructions before package approval. */
  workspacePaths(id: string): readonly string[] {
    const { location, directory, preview } = this.requirePreview(id);
    if (location.scope === 'user') return [];
    const parent = location.scopePrefix ? location.scopePrefix + '/' + directory : directory;
    return preview.files.map(file => parent + '/' + file.path);
  }
  async apply(id: string, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    const change = this.requirePreview(id);
    this.pending.delete(id);
    signal?.throwIfAborted();
    if (this.ensureReady) await this.ensureReady();
    const cleaned = await withSkillLock(
      change.location.store.root,
      'destination',
      async () => {
        await this.recoverLocation(change.location, await change.location.store.resolvePath(change.location.directory));
        return this.withPackageScope(change.location, change.directory, () => this.commit(change, signal), signal);
      },
      signal,
    );
    try {
      await this.catalog.refresh();
      return cleaned
        ? { applied: true }
        : { applied: true, refreshError: 'The package changed successfully. Backup cleanup will retry on refresh.' };
    } catch {
      return {
        applied: true,
        refreshError: 'The package was changed successfully. Refresh Skills to update the catalog.',
      };
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (this.ensureReady) await this.ensureReady();
    const skill = this.catalog.skills.find(skill => skill.id === id && skill.status === 'active');
    if (!skill) throw new Error('Skill is unavailable.');
    const location = this.locations.find(item => item.id === skill.origin.id);
    if (location)
      await withSkillLock(location.store.root, 'destination', async () => {
        await this.recoverLocation(location, await location.store.resolvePath(location.directory));
        if (!(await location.store.exists(skill.directory)))
          throw new Error('The installed skill is missing. Refresh Settings.');
        await this.state.setEnabled(id, enabled);
      });
    else await this.state.setEnabled(id, enabled);
    await this.catalog.refresh();
  }
  private requirePreview(id: string) {
    const change = this.pending.get(id);
    if (!change) throw new Error('Skill preview expired. Preview the change again.');
    return change;
  }
  private location(id: string) {
    const location = this.locations.find(candidate => candidate.id === id);
    if (!location) throw new Error('This skill location cannot be managed.');
    return location;
  }
  private async target(location: SkillPackageLocation, directory: string) {
    const key = (path: string) => (location.store.caseSensitive ? path : path.toLowerCase());
    const parent = key(posix.dirname(directory));
    const marker = key(location.directory);
    if (
      location.store.normalizePath(directory) !== directory ||
      !(parent === marker || (location.scope === 'project' && parent.endsWith('/' + marker)))
    )
      throw new Error('Skill directory is outside its managed location.');
    return location.store.resolvePath(directory);
  }
  private async remember(
    location: SkillPackageLocation,
    directory: string,
    before: PackageFiles,
    draft?: SkillPackageDraft,
  ): Promise<SkillPreview> {
    const path = await this.target(location, directory);
    await this.checkPendingOrigin(location, path);
    await location.assertClean?.(path);
    const after = draft?.packageFiles(before);
    const expected = before.size > 0 ? packageRevision(before) : null;
    const preview: SkillPreview = {
      id: randomUUID(),
      action: draft ? (before.size > 0 ? 'update' : 'install') : 'remove',
      targetId: location.id,
      destination: { label: location.label, scope: location.scope, path },
      name: posix.basename(directory),
      source: draft?.source ?? 'Installed package',
      revision: after ? packageRevision(after) : expected!,
      files: compareFiles(before, after ?? new Map()),
    };
    if (this.pending.size >= 32) throw new Error('Too many pending skill previews. Finish or discard a preview first.');
    this.pending.set(preview.id, { preview, location, directory, expected, ...(after ? { files: after } : {}) });
    return structuredClone(preview);
  }
  private async read(location: SkillPackageLocation, directory: string): Promise<PackageFiles> {
    const root = await this.target(location, directory);
    if (!(await optionalStat(root))) return new Map();
    const prefix = directory + '/';
    const inventory = await inventoryFiles(root);
    await this.assertIndexed(location, directory, inventory);
    const files = new Map<string, SkillPackageFile>();
    let total = 0;
    for (const path of inventory) {
      const raw = await location.store.readBytes(prefix + path, { maxBytes: 1024 * 1024 });
      if ((total += raw.bytes.length) > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
      if (textContent(raw.bytes) !== undefined) {
        const live = await location.workspace.read(prefix + path, { maxBytes: 1024 * 1024 });
        if (live.revision !== raw.revision) throw new Error('Save skill edits before managing the package.');
      }
      files.set(path, raw);
    }
    return files;
  }
  private async assertIndexed(location: SkillPackageLocation, directory: string, inventory: readonly string[]) {
    const listed = await location.listFiles();
    if (listed.truncated) throw new Error('Skill catalog is incomplete.');
    const prefix = directory + '/';
    const paths = new Set(listed.files.filter(path => path.startsWith(prefix)));
    if (paths.size > 256) throw new Error('Skill package exceeds 256 files.');
    if (inventory.length !== paths.size || inventory.some(path => !paths.has(prefix + path)))
      throw new Error('Package contains unindexed or unauthorized files. Refresh before managing it.');
  }
  private async persist(entry: SkillTransaction) {
    if (entry.replacement) await this.state.record(entry.skillId, entry.source!, entry.replacement);
    else await this.state.forget(entry.skillId);
  }
  private async recoverLocation(location: SkillPackageLocation, root: string) {
    for (const entry of await this.journal.entries(root, location.id)) {
      await this.withPackageScope(location, entry.directory, async () => {
        if (entry.retired) {
          await this.cleanup(location, entry);
          return;
        }
        const target = await this.target(location, entry.directory);
        const stage = join(await privateSkillDirectory(location.store.root), entry.id);
        await location.assertClean?.(target);
        if (entry.published) {
          if ((await diskRevision(target)) !== entry.replacement)
            throw new Error('Package recovery is required. Published files changed at ' + target);
          await this.assertBackup(entry, stage);
          await this.persist(entry);
        } else {
          await this.rollback(location, entry, stage, target);
          await location.refreshIndex();
        }
        await this.finish(location, entry);
      });
    }
  }

  private async withPackageScope<T>(
    location: SkillPackageLocation,
    directory: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    if (location.scope !== 'project') return work();
    const target = await this.target(location, directory);
    let scope = dirname(target);
    for (const _ of location.directory.split('/')) scope = dirname(scope);
    // All callers already hold the attached-root lock. Nested scopes acquire their own physical lock second.
    return scope === location.store.root ? work() : withSkillLock(scope, 'destination', work, signal);
  }
  private async checkPendingOrigin(location: SkillPackageLocation, destination: string) {
    if (location.scope === 'project' && (await this.journal.hasOtherProjectTransaction(location.id, destination)))
      throw new Error(
        'An unfinished skill change belongs to another project root. Reopen the original project to recover it.',
      );
  }
  private async assertBackup(entry: SkillTransaction, stage: string) {
    if (entry.expected && (await diskRevision(join(stage, 'previous'))) !== entry.expected)
      throw new Error('Package recovery is required. Inspect retained staging at ' + stage);
  }
  private async finish(location: SkillPackageLocation, entry: SkillTransaction) {
    // Record the decision before cleanup so an interruption can finish deleting only our private staging.
    await this.journal.write({ ...entry, retired: true });
    return this.cleanup(location, entry);
  }
  private async cleanup(location: SkillPackageLocation, entry: SkillTransaction) {
    try {
      await location.mutations.removeTree('.skill-staging/' + entry.id);
      await this.journal.finish(entry.id);
      return true;
    } catch {
      // The durable retirement already settled both the installed files and profile state.
      return false;
    }
  }
  private async rollback(location: SkillPackageLocation, entry: SkillTransaction, stage: string, target: string) {
    const backup = join(stage, 'previous');
    let saved: boolean;
    try {
      saved = !!(await optionalStat(backup));
    } catch (cause) {
      throw new Error('Package recovery is required. Inspect retained staging at ' + stage, { cause });
    }
    const relativeStage = '.skill-staging/' + entry.id;
    const reverted = join(stage, 'reverted');
    const retained = await diskRevision(reverted);
    if (retained !== null && retained !== entry.replacement)
      throw new Error('Package recovery is required. Inspect the changed candidate at ' + reverted);
    const actual = await diskRevision(target);
    // An initial occupant that never moved remains authoritative, including concurrent edits.
    if (entry.expected && !saved) {
      if (actual !== entry.expected)
        throw new Error('Package recovery is required. Inspect the changed original at ' + target);
      return;
    }
    if (actual !== null) {
      if (actual !== entry.replacement) {
        if (!saved && !entry.published && (await optionalStat(join(stage, 'package')))) return;
        throw new Error('Package recovery is required. Preserved backups at ' + backup);
      }
      // A candidate still in staging means an independent installation occupies this path.
      if (await optionalStat(join(stage, 'package'))) {
        if (!saved) return;
        throw new Error('Package recovery is required. Preserved backups at ' + backup);
      }
      await location.mutations.renameExclusive(entry.directory, relativeStage + '/reverted');
      if ((await diskRevision(reverted)) !== entry.replacement)
        throw new Error('Package recovery is required. Inspect the changed candidate at ' + reverted);
    }
    if (saved) await location.mutations.renameExclusive(relativeStage + '/previous', entry.directory);
  }
  private async commit(change: Pending, signal?: AbortSignal) {
    const { location, directory, preview, files, expected } = change;
    const root = await location.store.resolvePath(location.directory);
    await location.refreshIndex();
    const current = await this.read(location, directory);
    if ((current.size > 0 ? packageRevision(current) : null) !== expected)
      throw new Error('The skill changed after preview. Preview it again.');
    const target = await this.target(location, directory);
    await this.checkPendingOrigin(location, target);
    if (preview.destination.path !== target) throw new Error('The skill destination changed after preview.');
    // mkdir applies the process umask to newly created project parents. The published tree
    // then inherits the actual parent permissions, including a checkout's deliberate sharing settings.
    await location.mutations.ensureDirectory(posix.dirname(directory), location.scope === 'project' ? 0o777 : 0o700);
    const directoryMode = location.scope === 'project' ? (await lstat(dirname(target))).mode & 0o777 : 0o700;
    const relativeStage = '.skill-staging/' + preview.id;
    const stage = join(await privateSkillDirectory(location.store.root), preview.id);
    await location.mutations.createStage(relativeStage);
    const entry: SkillTransaction = {
      id: preview.id,
      root,
      location: location.id,
      directory,
      skillId: location.packageId?.(directory) ?? skillPackageId(location.id, directory),
      expected,
      replacement: files ? preview.revision : null,
      source: files ? preview.source : null,
      published: false,
      retired: false,
    };
    const backup = join(stage, 'previous');
    let preferencesCommitted = false,
      recorded = false;
    try {
      await this.journal.write(entry);
      recorded = true;
      if (files) {
        signal?.throwIfAborted();
        await location.mutations.stagePackage(
          relativeStage + '/package',
          files,
          await packageDirectoryModes(target, files, directoryMode),
        );
        if ((await diskRevision(join(stage, 'package'))) !== preview.revision)
          throw new Error('The staged skill is unreadable or changed. Preview it again.');
      }
      await location.assertClean?.(target);
      signal?.throwIfAborted();
      if (expected) {
        await location.mutations.renameExclusive(directory, relativeStage + '/previous');
        if ((await diskRevision(backup)) !== expected)
          throw new Error('The skill changed during replacement. Preview it again.');
      } else if (await optionalStat(target)) throw new Error('A skill appeared at the destination. Preview again.');
      signal?.throwIfAborted();
      if (files) await location.mutations.renameExclusive(relativeStage + '/package', directory);
      if ((await diskRevision(target)) !== entry.replacement) throw new Error('The skill changed during publication.');
      await location.refreshIndex();
      if (files) await this.assertIndexed(location, directory, [...files.keys()]);
      await location.assertClean?.(target);
      await this.assertBackup(entry, stage);
      signal?.throwIfAborted();
      entry.published = true;
      await this.journal.write(entry);
      await this.persist(entry);
      preferencesCommitted = true;
      if ((await diskRevision(target)) !== entry.replacement)
        throw new Error('Published files changed. Package recovery is required at ' + target);
      await this.assertBackup(entry, stage);
    } catch (error) {
      if (preferencesCommitted || error instanceof SkillPreferenceCommitUncertain) throw error;
      if (recorded) {
        if (entry.published) {
          entry.published = false;
          await this.journal.write(entry);
        }
        await this.rollback(location, entry, stage, target);
        await location.refreshIndex();
        await this.finish(location, entry);
      } else await location.mutations.removeTree(relativeStage);
      throw error;
    }
    return this.finish(location, entry);
  }
}
