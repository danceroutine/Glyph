import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';
import { SkillProjectMutationPolicy } from './SkillProjectMutationPolicy.ts';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import { SkillPreferenceCommitUncertain, type SkillStateStore } from './SkillStateStore.ts';
import type { SkillPreview, SkillPreviewFile, SkillPreviewFileInfo } from './SkillLifecycle.ts';
import { SkillPackageDraft } from './SkillPackageDraft.ts';
import type { SkillPackageFile } from './SkillPackage.ts';
import { packageRevision, fileDirectories } from './skillPackageRevision.ts';
import { skillPackageId } from './skillPackageId.ts';
import { inventoryPackage, readDirectoryModes, readPackageFiles } from './skillPackageInventory.ts';
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
  readonly listPackageDirectories?: (directory: string) => Promise<ReadonlyMap<string, number>>;
  readonly refreshIndex: () => Promise<void>;
  readonly packageId?: (directory: string) => string;
  readonly updateOnly?: boolean;
  readonly assertClean?: (absolutePackageDirectory: string) => Promise<void>;
}
type PackageFiles = ReadonlyMap<string, SkillPackageFile>;
interface PackageTree {
  rootMode?: number;
  metadata?: string;
  files: PackageFiles;
  directories: ReadonlyMap<string, number>;
}
interface Pending {
  readonly preview: SkillPreview & { directories: NonNullable<SkillPreview['directories']> };
  readonly location: SkillPackageLocation;
  readonly directory: string;
  readonly files?: PackageFiles;
  readonly directories: ReadonlyMap<string, number>;
  readonly expected: string | null;
  readonly expectedMetadata?: string;
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
function compareDirectories(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].toSorted().map(path => {
    const beforeMode = before.get(path);
    const afterMode = after.get(path);
    const status =
      beforeMode === undefined
        ? 'added'
        : afterMode === undefined
          ? 'removed'
          : beforeMode === afterMode
            ? 'unchanged'
            : 'modified';
    return {
      path,
      status,
      ...(beforeMode === undefined ? {} : { beforeMode }),
      ...(afterMode === undefined ? {} : { afterMode }),
    } as const;
  });
}
async function diskRevision(directory: string, treeVersion?: 2): Promise<string | null> {
  if (!(await optionalStat(directory))) return null;
  const { files, directories } = await inventoryPackage(directory);
  const modes = treeVersion && (await readDirectoryModes(directories, async path => join(directory, path)));
  return packageRevision(await readPackageFiles(directory, files), modes);
}
/** Observe ordinary directory permissions without touching the checkout or changing the process-wide umask. */
async function newDirectoryMode(): Promise<number> {
  const privateRoot = await mkdtemp(join(tmpdir(), 'glyph-skill-mode-'));
  try {
    const path = join(privateRoot, 'directory');
    await mkdir(path, { mode: 0o777 });
    return (await lstat(path)).mode & 0o777;
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
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
    this.journal = new SkillTransactionJournal(state.userDirectory, state.metadata);
    this.projectMutationPolicy = new SkillProjectMutationPolicy(locations, catalog);
  }
  get targets() {
    return this.locations.map(location => ({
      id: location.id,
      scope: location.scope,
      ...(location.updateOnly ? { updateOnly: true } : {}),
      label: location.label,
      uri: pathToFileURL(join(location.store.root, location.directory)).toString(),
    }));
  }
  async recover(originId?: string, directory?: string): Promise<void> {
    for (const location of this.locations) {
      if (originId !== undefined && location.id !== originId) continue;
      const root = await location.store.resolvePath(location.directory);
      if ((await this.journal.entries(root, location.id)).length > 0)
        await withSkillLock(this.state.metadata, location.store.root, 'destination', () =>
          this.recoverLocation(location, root),
        );
      if (directory) await this.checkPendingOrigin(location, await this.target(location, directory));
    }
  }
  async prepare(targetId: string, draft: SkillPackageDraft, replaceId?: string): Promise<SkillPreview> {
    if (this.ensureReady) await this.ensureReady();
    const location = this.location(targetId);
    if (!replaceId && location.updateOnly)
      throw new Error('This installation directory belongs to the user skill store. Select User skills.');
    await this.recover(location.id);
    const existing = replaceId ? this.catalog.skills.find(skill => skill.id === replaceId) : undefined;
    if (replaceId && (!existing?.directory || existing.origin.id !== targetId || existing.name !== draft.name))
      throw new Error('The update must target the selected installed skill.');
    const directory = existing?.directory ?? location.directory + '/' + draft.name;
    for (const path of [...draft.files().keys(), ...draft.packageDirectories().keys()])
      location.store.normalizePath(directory + '/' + path);
    const before = await this.read(location, directory);
    if (!replaceId && (before.files.size > 0 || (await location.store.exists(directory))))
      throw new Error('A skill already occupies this destination. Select Update.');
    if (replaceId && before.files.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, directory, before, draft);
  }
  async prepareRemoval(id: string): Promise<SkillPreview> {
    if (this.ensureReady) await this.ensureReady();
    const descriptor = this.catalog.skills.find(skill => skill.id === id);
    if (!descriptor?.directory || !descriptor.path) throw new Error('Skill is unavailable. Refresh Settings.');
    const location = this.location(descriptor.origin.id);
    await this.recover(location.id);
    const before = await this.read(location, descriptor.directory);
    if (before.files.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
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
    const implicit = fileDirectories(preview.files.map(file => file.path));
    return [...preview.files, ...preview.directories.filter(entry => !implicit.has(entry.path))].map(
      entry => parent + '/' + entry.path,
    );
  }
  async apply(id: string, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    const change = this.requirePreview(id);
    this.pending.delete(id);
    signal?.throwIfAborted();
    if (this.ensureReady) await this.ensureReady();
    const cleaned = await withSkillLock(
      this.state.metadata,
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
      await this.state.setEnabled(id, enabled, async () => {
        if (!(await location.store.exists(skill.directory)))
          throw new Error('The installed skill is missing. Refresh Settings.');
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
    before: PackageTree,
    draft?: SkillPackageDraft,
  ): Promise<SkillPreview> {
    const path = await this.target(location, directory);
    await this.checkPendingOrigin(location, path);
    await location.assertClean?.(path);
    const after = draft?.packageFiles(before.files);
    const parentMode = location.scope === 'project' ? (await optionalStat(dirname(path)))?.mode : 0o700;
    const rootMode = before.rootMode ?? (parentMode ?? (await newDirectoryMode())) & 0o777;
    const directories = draft?.packageDirectories(before.directories, rootMode) ?? new Map<string, number>();
    const expected = before.files.size > 0 ? packageRevision(before.files, before.directories) : null;
    const expectedMetadata = before.metadata;
    const preview: Pending['preview'] = {
      id: randomUUID(),
      action: draft ? (before.files.size > 0 ? 'update' : 'install') : 'remove',
      targetId: location.id,
      destination: { label: location.label, scope: location.scope, path },
      name: posix.basename(directory),
      source: draft?.source ?? 'Installed package',
      revision: after ? packageRevision(after, directories) : expected!,
      files: compareFiles(before.files, after ?? new Map()),
      directories: compareDirectories(before.directories, directories),
    };
    if (this.pending.size >= 32) throw new Error('Too many pending skill previews. Finish or discard a preview first.');
    this.pending.set(preview.id, {
      preview,
      location,
      directory,
      expected,
      directories,
      ...(expectedMetadata ? { expectedMetadata } : {}),
      ...(after ? { files: after } : {}),
    });
    return structuredClone(preview);
  }
  private async read(location: SkillPackageLocation, directory: string): Promise<PackageTree> {
    const root = await this.target(location, directory);
    const stat = await optionalStat(root);
    if (!stat) return { files: new Map(), directories: new Map() };
    const metadata = await location.mutations.assertReplaceableMetadata(directory, true);
    const prefix = directory + '/';
    const inventory = await inventoryPackage(root);
    await this.assertIndexed(location, directory, inventory.files);
    const implicit = fileDirectories(inventory.files);
    const extra = inventory.directories.filter(path => !implicit.has(path));
    await this.assertDirectories(location, directory, extra);
    const directories = await readDirectoryModes(inventory.directories, path =>
      location.store.resolvePath(prefix + path),
    );
    const files = new Map<string, SkillPackageFile>();
    let total = 0;
    for (const path of inventory.files) {
      const raw = await location.store.readBytes(prefix + path, { maxBytes: 1024 * 1024 });
      if ((total += raw.bytes.length) > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
      if (textContent(raw.bytes) !== undefined) {
        const live = await location.workspace.read(prefix + path, { maxBytes: 1024 * 1024 });
        if (live.revision !== raw.revision) throw new Error('Save skill edits before managing the package.');
      }
      files.set(path, raw);
    }
    return { files, directories, rootMode: stat.mode & 0o777, metadata };
  }
  private async assertDirectories(location: SkillPackageLocation, directory: string, extra: readonly string[]) {
    if (extra.length === 0) return;
    const indexed = await location.listPackageDirectories?.(directory);
    if (!indexed || extra.some(path => !indexed.has(path)))
      throw new Error('Package contains unindexed or unauthorized directories. Refresh before managing it.');
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
        const stage = join(await privateSkillDirectory(this.state.metadata, location.store.root), entry.id);
        await inspectPrivateDirectory(this.state.metadata, stage);
        await location.assertClean?.(target);
        if (entry.published) {
          if ((await diskRevision(target, entry.treeVersion)) !== entry.replacement)
            throw new Error('Package recovery is required. Published files changed at ' + target);
          if (entry.replacement) await this.checkMetadata(location, entry.directory, entry.replacementMetadata);
          await this.assertBackup(location, entry, stage);
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
    return scope === location.store.root
      ? work()
      : withSkillLock(this.state.metadata, scope, 'destination', work, signal);
  }
  private async checkPendingOrigin(location: SkillPackageLocation, destination: string) {
    if (await this.journal.hasOtherProjectTransaction(location.id, destination))
      throw new Error(
        'An unfinished skill change belongs to another project root. Reopen the original project to recover it.',
      );
  }
  private async checkMetadata(
    location: SkillPackageLocation,
    path: string,
    expected?: string,
    ownershipReference?: string,
  ) {
    const current = await location.mutations.assertReplaceableMetadata(path, true, ownershipReference);
    if (expected && current !== expected) throw new Error('Skill access metadata changed. Review the package again.');
  }
  private async assertBackup(location: SkillPackageLocation, entry: SkillTransaction, stage: string) {
    if (entry.expected)
      await this.checkMetadata(location, '.skill-staging/' + entry.id + '/previous', entry.expectedMetadata);
    if (entry.expected && (await diskRevision(join(stage, 'previous'), entry.treeVersion)) !== entry.expected)
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
    const retained = await diskRevision(reverted, entry.treeVersion);
    if (retained !== null && retained !== entry.replacement)
      throw new Error('Package recovery is required. Inspect the changed candidate at ' + reverted);
    const actual = await diskRevision(target, entry.treeVersion);
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
      await this.checkMetadata(location, entry.directory, entry.replacementMetadata);
      await location.mutations.renameExclusive(entry.directory, relativeStage + '/reverted');
      if ((await diskRevision(reverted, entry.treeVersion)) !== entry.replacement)
        throw new Error('Package recovery is required. Inspect the changed candidate at ' + reverted);
    }
    if (saved) await location.mutations.renameExclusive(relativeStage + '/previous', entry.directory);
  }
  private async commit(change: Pending, signal?: AbortSignal) {
    const { location, directory, preview, files, expected } = change;
    const root = await location.store.resolvePath(location.directory);
    await location.refreshIndex();
    const current = await this.read(location, directory);
    if ((current.files.size > 0 ? packageRevision(current.files, current.directories) : null) !== expected)
      throw new Error('The skill changed after preview. Preview it again.');
    const target = await this.target(location, directory);
    await this.checkPendingOrigin(location, target);
    if (preview.destination.path !== target) throw new Error('The skill destination changed after preview.');
    // mkdir applies the process umask to newly created project parents. The published tree
    // then inherits the actual parent permissions, including a checkout's deliberate sharing settings.
    await location.mutations.ensureDirectory(posix.dirname(directory), location.scope === 'project' ? 0o777 : 0o700);
    const directoryMode = location.scope === 'project' ? (await lstat(dirname(target))).mode & 0o777 : 0o700;
    const relativeStage = '.skill-staging/' + preview.id;
    const stage = join(await privateSkillDirectory(this.state.metadata, location.store.root), preview.id);
    await location.mutations.createStage(relativeStage);
    await inspectPrivateDirectory(this.state.metadata, stage);
    const entry: SkillTransaction = {
      id: preview.id,
      treeVersion: 2,
      root,
      location: location.id,
      directory,
      skillId: location.packageId?.(directory) ?? skillPackageId(location.id, directory),
      expected,
      ...(change.expectedMetadata ? { expectedMetadata: change.expectedMetadata } : {}),
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
        const installed = await optionalStat(target);
        const modes = new Map<string, number>([
          ['', installed?.isDirectory() ? installed.mode & 0o777 : directoryMode],
          ...change.directories,
        ]);
        await location.mutations.stagePackage(relativeStage + '/package', files, modes);
        entry.replacementMetadata = await location.mutations.assertReplaceableMetadata(
          relativeStage + '/package',
          true,
          relativeStage + '/package',
        );
        await this.journal.write(entry);
        if ((await diskRevision(join(stage, 'package'), entry.treeVersion)) !== preview.revision)
          throw new Error('The staged skill is unreadable or changed. Preview it again.');
      }
      await location.assertClean?.(target);
      signal?.throwIfAborted();
      // The staging directory has its own inheritance. Check the actual destination parent as well as the saved tree.
      if (files)
        await location.mutations.assertReplaceableMetadata(posix.dirname(directory), false, relativeStage + '/package');
      if (expected) {
        await this.checkMetadata(
          location,
          directory,
          change.expectedMetadata,
          files ? relativeStage + '/package' : undefined,
        );
        await location.mutations.renameExclusive(directory, relativeStage + '/previous');
        await this.checkMetadata(
          location,
          relativeStage + '/previous',
          change.expectedMetadata,
          files ? relativeStage + '/package' : undefined,
        );
        if ((await diskRevision(backup, entry.treeVersion)) !== expected)
          throw new Error('The skill changed during replacement. Preview it again.');
      } else if (await optionalStat(target)) throw new Error('A skill appeared at the destination. Preview again.');
      signal?.throwIfAborted();
      if (files) await location.mutations.renameExclusive(relativeStage + '/package', directory);
      if ((await diskRevision(target, entry.treeVersion)) !== entry.replacement)
        throw new Error('The skill changed during publication.');
      await location.refreshIndex();
      if (files) {
        await this.assertIndexed(location, directory, [...files.keys()]);
        const implicit = fileDirectories(files.keys());
        await this.assertDirectories(
          location,
          directory,
          [...change.directories.keys()].filter(path => !implicit.has(path)),
        );
      }
      await location.assertClean?.(target);
      if (files) await this.checkMetadata(location, directory, entry.replacementMetadata);
      await this.assertBackup(location, entry, stage);
      signal?.throwIfAborted();
      entry.published = true;
      await this.journal.write(entry);
      await this.persist(entry);
      preferencesCommitted = true;
      if ((await diskRevision(target, entry.treeVersion)) !== entry.replacement)
        throw new Error('Published files changed. Package recovery is required at ' + target);
      if (files) await this.checkMetadata(location, directory, entry.replacementMetadata);
      await this.assertBackup(location, entry, stage);
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
