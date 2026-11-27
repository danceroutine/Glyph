import type { SourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { sameWorkspaceDirectorySpelling } from '#src/workspace/sameWorkspaceDirectory.js';
import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';
import { SkillProjectMutationPolicy } from './SkillProjectMutationPolicy.ts';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import { SkillPreferenceCommitUncertain, type SkillStateStore } from './SkillStateStore.ts';
import type { SkillPreview, SkillPreviewFile, SkillPreviewFileInfo } from './SkillLifecycle.ts';
import { installedPackageModes } from './installedPackageModes.ts';
import { SkillPackageDraft, type PendingSkillSourceAccess } from './SkillPackageDraft.ts';
import type { SkillPackageFile } from './SkillPackage.ts';
import { packageRevision, fileDirectories } from './skillPackageRevision.ts';
import { skillPackageId } from './skillPackageId.ts';
import { inventoryPackage, readDirectoryModes, diskRevision } from './skillPackageInventory.ts';
import { optionalStat, privateSkillDirectory, withSkillLock } from './SkillPackageStorage.ts';
import { SkillTransactionJournal, type SkillTransaction } from './SkillTransactionJournal.ts';

export interface SkillPackageLocation {
  readonly id: string;
  readonly label: string;
  readonly scope: 'user' | 'project';
  /** Workspace routing prefix for project packages in a multi-root window. */
  readonly scopePrefix?: string;
  /** The installed tree is read through the destination's policy-bound disk adapter. */
  readonly store: Pick<WorkspaceTextStore, 'root' | 'caseSensitive' | 'normalizePath' | 'exists'> &
    Pick<FileSystemWorkspaceTextStore, 'readBytes' | 'resolvePath'>;
  readonly workspace: WorkspaceTextStore;
  readonly mutations: WorkspaceDirectoryMutations;
  readonly directory: string;
  readonly listFiles: (
    directory: string,
  ) => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  readonly listPackageDirectories?: (directory: string) => Promise<ReadonlyMap<string, number>>;
  readonly refreshIndex: () => Promise<void>;
  readonly packageId?: (directory: string) => string;
  readonly updateOnly?: boolean;
  readonly admitsPackage?: (absolutePackageDirectory: string) => boolean;
  readonly sourcePathAliases?: SourcePathAliases;
  readonly assertClean?: (absolutePackageDirectory: string, retainedAliases?: readonly string[]) => Promise<void>;
}
type PackageFiles = ReadonlyMap<string, SkillPackageFile>;
interface PackageTree {
  rootMode?: number;
  metadata?: string;
  files: PackageFiles;
  directories: ReadonlyMap<string, number>;
}
interface Pending {
  readonly sourceAccess: PendingSkillSourceAccess | undefined;
  readonly preview: SkillPreview & {
    directories: NonNullable<SkillPreview['directories']>;
    createdParentDirectories: readonly string[];
  };
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
/** Enumerate the parent directories that publishing the package would create. */
async function missingParents(target: string): Promise<string[]> {
  const parents = [];
  for (let parent = dirname(target); !(await optionalStat(parent)); parent = dirname(parent)) parents.unshift(parent);
  return parents;
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
    private readonly workspaceRoutes = new WorkspaceSourceRoutes(
      locations
        .filter(location => location.scope === 'project')
        .map(location => ({
          name: location.scopePrefix ?? location.id,
          path: location.store.root,
          caseSensitive: location.store.caseSensitive,
        })),
    ),
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
  async recover(originId?: string, directory?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const location of this.locations) {
      if (originId !== undefined && location.id !== originId) continue;
      const root = await this.journalRoot(location);
      if ((await this.journal.entries(root, location.id)).length > 0)
        await withSkillLock(
          this.state.metadata,
          location.store.root,
          'destination',
          () => this.recoverLocation(location, root),
          signal,
        );
      if (directory) await this.checkPendingOrigin(location, await this.target(location, directory));
    }
  }
  async prepare(
    targetId: string,
    draft: SkillPackageDraft,
    replaceId?: string,
    signal?: AbortSignal,
  ): Promise<SkillPreview> {
    signal?.throwIfAborted();
    if (this.ensureReady) await this.ensureReady();
    const location = this.location(targetId);
    if (!replaceId && location.updateOnly)
      throw new Error('This installation directory belongs to the user skill store. Select User skills.');
    await this.recover(location.id, undefined, signal);
    const existing = replaceId ? this.catalog.skills.find(skill => skill.id === replaceId) : undefined;
    if (replaceId && (!existing?.directory || existing.origin.id !== targetId || existing.name !== draft.name))
      throw new Error('The update must target the selected installed skill.');
    const directory = existing?.directory ?? location.directory + '/' + draft.name;
    for (const path of [...draft.files().keys(), ...draft.packageDirectories().keys()])
      location.store.normalizePath(directory + '/' + path);
    const before = await this.read(location, directory);
    if (!replaceId && (before.files.size > 0 || (await location.store.exists(directory)))) {
      if (
        before.files.size > 0 &&
        this.catalog.skills.some(
          skill =>
            skill.origin.id === targetId && skill.directory === directory && skill.name === draft.name && skill.path,
        )
      )
        throw new Error('A skill already occupies this destination. Select Update.');
      throw new Error('A directory already occupies this destination. Move it or choose a different package name.');
    }
    if (replaceId && before.files.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, directory, before, draft, signal);
  }
  async prepareRemoval(id: string, signal?: AbortSignal): Promise<SkillPreview> {
    signal?.throwIfAborted();
    if (this.ensureReady) await this.ensureReady();
    const descriptor = this.catalog.skills.find(skill => skill.id === id);
    if (!descriptor?.directory || !descriptor.path) throw new Error('Skill is unavailable. Refresh Settings.');
    const location = this.location(descriptor.origin.id);
    await this.recover(location.id, undefined, signal);
    const before = await this.read(location, descriptor.directory);
    if (before.files.size === 0) throw new Error('The installed skill is missing. Refresh Settings.');
    return this.remember(location, descriptor.directory, before, undefined, signal);
  }
  discard(id: string): void {
    this.pending.get(id)?.sourceAccess?.release();
    this.pending.delete(id);
  }
  dispose(): void {
    for (const id of this.pending.keys()) this.discard(id);
  }
  hasPreview(id: string): boolean {
    return this.pending.has(id);
  }
  /** The complete destination inventory can disclose scoped instructions before package approval. */
  workspacePaths(id: string): readonly string[] {
    const { preview, location } = this.requirePreview(id);
    const paths = [
      ...preview.createdParentDirectories,
      preview.destination.path,
      ...[...preview.files, ...preview.directories].map(entry => join(preview.destination.path, entry.path)),
    ];
    const aliases = location.sourcePathAliases;
    const visible = new Set(paths);
    if (aliases) {
      for (const alias of aliases.batch?.(paths) ?? paths.flatMap(path => aliases(path))) visible.add(alias);
    }
    return [...new Set([...visible].flatMap(path => this.workspaceRoutes.routesForPhysicalPath(path)))];
  }
  async apply(id: string, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    const change = this.requirePreview(id);
    this.pending.delete(id);
    let cleaned: boolean;
    try {
      signal?.throwIfAborted();
      if (this.ensureReady) await this.ensureReady();
      cleaned = await withSkillLock(
        this.state.metadata,
        change.location.store.root,
        'destination',
        async () => {
          await this.recoverLocation(change.location, await this.journalRoot(change.location));
          return this.withPackageScope(change.location, change.directory, () => this.commit(change, signal), signal);
        },
        signal,
      );
    } finally {
      change.sourceAccess?.release();
    }
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
  /** Change a preference on behalf of the issuing window. Its command lifetime follows the write to disk. */
  async setEnabled(id: string, enabled: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.ensureReady) await this.ensureReady();
    const skill = this.catalog.skills.find(skill => skill.id === id && skill.status === 'active');
    if (!skill) throw new Error('Skill is unavailable.');
    const location = this.locations.find(item => item.id === skill.origin.id);
    if (location)
      await this.state.setEnabled(id, enabled, signal, async () => {
        if (!(await location.store.exists(skill.directory)))
          throw new Error('The installed skill is missing. Refresh Settings.');
      });
    else await this.state.setEnabled(id, enabled, signal);
    await this.catalog.refresh();
  }
  /** Journal keys identify the installation location. A project that contains the personal store can still
   * own packages below other nested collection directories. Every recovered target passes through target(). */
  private async journalRoot(location: SkillPackageLocation): Promise<string> {
    return location.updateOnly
      ? join(location.store.root, location.directory)
      : location.store.resolvePath(location.directory);
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
    if (location.store.normalizePath(directory) !== directory)
      throw new Error('Skill directory is outside its managed location.');
    const parent = posix.dirname(directory);
    const scope = parent.split('/').slice(0, -location.directory.split('/').length).join('/');
    if (
      (scope !== '' && location.scope !== 'project') ||
      !sameWorkspaceDirectorySpelling(
        join(location.store.root, parent),
        join(location.store.root, scope, location.directory),
        location.store.caseSensitive,
      )
    )
      throw new Error('Skill directory is outside its managed location.');
    const target = await location.store.resolvePath(directory);
    this.assertAdmitted(location, target);
    return target;
  }
  private assertAdmitted(location: SkillPackageLocation, target: string) {
    if (location.admitsPackage && !location.admitsPackage(target))
      throw new Error('This package belongs to the user skill store. Select User skills.');
  }
  private async remember(
    location: SkillPackageLocation,
    directory: string,
    before: PackageTree,
    draft?: SkillPackageDraft,
    signal?: AbortSignal,
  ): Promise<SkillPreview> {
    const path = await this.target(location, directory);
    await this.checkPendingOrigin(location, path);
    await location.assertClean?.(path);
    const previous = draft && (await installedPackageModes(path, draft.entryPaths(), before));
    const after = draft?.packageFiles(previous?.files);
    const parentMode = location.scope === 'project' ? (await optionalStat(dirname(path)))?.mode : 0o700;
    const rootMode = before.rootMode ?? (parentMode ?? (await newDirectoryMode())) & 0o777;
    const directories = draft?.packageDirectories(previous?.directories, rootMode) ?? new Map<string, number>();
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
      createdParentDirectories: await missingParents(path),
      files: compareFiles(before.files, after ?? new Map()),
      directories: compareDirectories(before.directories, directories),
    };
    signal?.throwIfAborted();
    const sourceAccess = await draft?.sourceAccess?.retain();
    if (signal?.aborted || this.pending.size >= 32) {
      sourceAccess?.release();
      signal?.throwIfAborted();
      throw new Error('Too many pending skill previews. Finish or discard a preview first.');
    }
    this.pending.set(preview.id, {
      sourceAccess,
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
    const listed = await location.listFiles(directory);
    if (listed.truncated) throw new Error('Skill catalog is incomplete.');
    const prefix = directory + '/';
    const paths = new Set(listed.files.filter(path => path.startsWith(prefix)));
    if (paths.size > 256) throw new Error('Skill package exceeds 256 files.');
    if (inventory.length !== paths.size || inventory.some(path => !paths.has(prefix + path)))
      throw new Error('Package contains unindexed or unauthorized files. Refresh before managing it.');
  }
  /** Recheck the import and its issuing command together. Invoke the operation in this continuation,
   * so cancellation during asynchronous source admission wins before a native rename or commit starts. */
  private async publish<T>(
    change: Pending,
    signal: AbortSignal | undefined,
    relocation: Parameters<PendingSkillSourceAccess['assertCurrent']>[0],
    operation: () => Promise<T>,
  ): Promise<T> {
    await change.sourceAccess?.assertCurrent(relocation);
    signal?.throwIfAborted();
    this.assertAdmitted(change.location, change.preview.destination.path);
    return operation();
  }
  /** An acknowledged package commit retires its previous source for every turn sharing this catalog authority. */
  private async persist(entry: SkillTransaction, signal?: AbortSignal, verifySource?: () => Promise<void>) {
    if (entry.replacement)
      await this.state.record(entry.skillId, entry.source!, entry.replacement, signal, verifySource);
    else await this.state.forget(entry.skillId, signal, verifySource);
    if (entry.expected) this.catalog.retirements.publish(entry.skillId, entry.id);
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
        let retainedAliases: readonly string[] | undefined;
        const backup = join(stage, 'previous');
        if (location.sourcePathAliases && (await optionalStat(backup))) {
          // A crash can leave an editor's direct mount attached to the original inode now in private staging.
          const stageRoutes = location.sourcePathAliases(stage);
          retainedAliases = location
            .sourcePathAliases(backup, true)
            .filter(alias => !stageRoutes.some(route => alias === route || alias.startsWith(route + sep)));
        }
        await location.assertClean?.(target, retainedAliases);
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
    if (!entry.published && entry.createdParents) {
      for (let i = entry.createdParents.length - 1; i >= 0; i--)
        await location.mutations.rollbackParent(
          entry.createdParents[i]!,
          '.skill-staging/' + entry.id + '/parent-' + i,
        );
    }
    // Record the decision before cleanup so an interruption can finish deleting only our private staging.
    await this.journal.write({ ...entry, retired: true });
    return this.cleanup(location, entry);
  }
  private async cleanup(location: SkillPackageLocation, entry: SkillTransaction) {
    this.catalog.retirements.settled(entry.id);
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
    await change.sourceAccess?.assertCurrent();
    const root = await this.journalRoot(location);
    await location.refreshIndex();
    const current = await this.read(location, directory);
    if ((current.files.size > 0 ? packageRevision(current.files, current.directories) : null) !== expected)
      throw new Error('The skill changed after preview. Preview it again.');
    const target = await this.target(location, directory);
    await this.checkPendingOrigin(location, target);
    if (preview.destination.path !== target) throw new Error('The skill destination changed after preview.');
    if (JSON.stringify(await missingParents(target)) !== JSON.stringify(preview.createdParentDirectories))
      throw new Error('Installation directories changed after preview. Preview the change again.');
    const relativeStage = '.skill-staging/' + preview.id;
    const stage = join(await privateSkillDirectory(this.state.metadata, location.store.root), preview.id);
    const retainedAliases = location.sourcePathAliases?.(target, true);
    signal?.throwIfAborted();
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
    let swapStarted = false;
    let preferencesCommitted = false,
      recorded = false;
    try {
      await this.journal.write(entry);
      recorded = true;
      const mode = location.scope === 'project' ? 0o777 : 0o700;
      for (const parent of preview.createdParentDirectories) {
        signal?.throwIfAborted();
        const slot = relativeStage + '/parent-' + (entry.createdParents?.length ?? 0);
        const receipt = await location.mutations.stageParent(relative(location.store.root, parent), mode, slot);
        (entry.createdParents ??= []).push(receipt);
        await this.journal.write(entry);
        await this.publish(change, signal, undefined, () => location.mutations.renameExclusive(slot, receipt.relative));
      }
      // Reopen the reviewed parent chain without creating a directory that disappeared after preview.
      await location.mutations.ensureDirectory(posix.dirname(directory), mode, 0);
      if (files) {
        signal?.throwIfAborted();
        const installed = await optionalStat(target);
        const directoryMode = location.scope === 'project' ? (await lstat(dirname(target))).mode & 0o777 : 0o700;
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
      await location.assertClean?.(target, retainedAliases);
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
        await this.publish(change, signal, undefined, () => {
          swapStarted = true;
          return location.mutations.renameExclusive(directory, relativeStage + '/previous');
        });
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
      const relocation = expected ? { source: target, backup } : undefined;
      if (files) {
        await this.publish(change, signal, relocation, () => {
          swapStarted = true;
          return location.mutations.renameExclusive(relativeStage + '/package', directory);
        });
      }
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
      await location.assertClean?.(target, retainedAliases);
      if (files) await this.checkMetadata(location, directory, entry.replacementMetadata);
      await this.assertBackup(location, entry, stage);
      await this.publish(change, signal, relocation, () => {
        entry.published = true;
        return this.journal.write(entry, signal);
      });
      const source = change.sourceAccess;
      await this.persist(entry, signal, source && (() => source.assertCurrent(relocation)));
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
        // Before the first rename only our private stage changed. A concurrent save owns the live tree.
        if (swapStarted) {
          await this.rollback(location, entry, stage, target);
          await location.refreshIndex();
        }
        await this.finish(location, entry);
      } else await location.mutations.removeTree(relativeStage);
      throw error;
    }
    return this.finish(location, entry);
  }
}
