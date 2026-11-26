import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, open } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import { SkillPreferenceCommitUncertain, type SkillStateStore } from './SkillStateStore.ts';
import type { SkillPreview, SkillPreviewFile, SkillPreviewFileInfo } from './SkillLifecycle.ts';
import { SkillPackageDraft } from './SkillPackageDraft.ts';
import type { SkillPackageFile } from './SkillPackage.ts';
import { packageRevision } from './skillPackageRevision.ts';
import { skillPackageId } from './skillPackageId.ts';
import { inventoryFiles, readPackageFiles } from './skillPackageInventory.ts';
import { optionalStat, privateSkillDirectory, syncDirectory, withSkillLock } from './SkillPackageStorage.ts';
import { SkillTransactionJournal, type SkillTransaction } from './SkillTransactionJournal.ts';

export interface SkillPackageLocation {
  readonly id: string;
  readonly label: string;
  readonly scope: 'user' | 'project';
  readonly store: FileSystemWorkspaceTextStore;
  readonly workspace: WorkspaceTextStore;
  readonly directory: string;
  readonly listFiles: () => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  readonly refreshIndex: () => Promise<void>;
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
async function stagePackage(directory: string, files: PackageFiles, signal?: AbortSignal) {
  await mkdir(directory, { mode: 0o700 });
  const directories = new Set([directory]);
  for (const [path, file] of files) {
    signal?.throwIfAborted();
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    for (let current = dirname(destination); current !== directory; current = dirname(current))
      directories.add(current);
    const handle = await open(destination, 'wx', 0o600);
    try {
      await handle.writeFile(file.bytes);
      await handle.chmod(file.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const path of [...directories].toSorted((a, b) => b.length - a.length)) await syncDirectory(path);
}

/** Stages immutable packages, serializes each destination and recovers interrupted publication before discovery. */
export class SkillPackageManager {
  private readonly pending = new Map<string, Pending>();
  private readonly journal: SkillTransactionJournal;
  constructor(
    private readonly locations: readonly SkillPackageLocation[],
    private readonly catalog: SkillCatalog,
    private readonly state: SkillStateStore,
  ) {
    this.journal = new SkillTransactionJournal(state.userDirectory);
  }
  get targets() {
    return this.locations.map(location => ({
      id: location.id,
      label: location.label,
      uri: pathToFileURL(join(location.store.root, location.directory)).toString(),
    }));
  }
  async recover(): Promise<void> {
    for (const location of this.locations) {
      await privateSkillDirectory(location.store.root);
      const root = await location.store.resolvePath(location.directory);
      if ((await this.journal.entries(root, location.id)).length > 0)
        await withSkillLock(location.store.root, 'destination', () => this.recoverLocation(location, root));
    }
  }
  async prepare(targetId: string, draft: SkillPackageDraft, replaceId?: string): Promise<SkillPreview> {
    const location = this.location(targetId);
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
    const descriptor = this.catalog.skills.find(skill => skill.id === id);
    if (!descriptor?.directory || !descriptor.path || descriptor.id.endsWith(':discovery-error'))
      throw new Error('Skill is unavailable. Refresh Settings.');
    const location = this.location(descriptor.origin.id);
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
  async apply(id: string, signal?: AbortSignal): Promise<{ applied: true; refreshError?: string }> {
    const change = this.pending.get(id);
    if (!change) throw new Error('Skill preview expired. Preview the change again.');
    this.pending.delete(id);
    signal?.throwIfAborted();
    await withSkillLock(change.location.store.root, 'destination', () => this.commit(change, signal), signal);
    try {
      await change.location.refreshIndex();
      await this.catalog.refresh();
      return { applied: true };
    } catch {
      return {
        applied: true,
        refreshError: 'The package was changed successfully. Refresh Skills to update the catalog.',
      };
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
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
  private location(id: string) {
    const location = this.locations.find(candidate => candidate.id === id);
    if (!location) throw new Error('This skill location cannot be managed.');
    return location;
  }
  private async target(location: SkillPackageLocation, directory: string) {
    const parent = posix.dirname(directory);
    if (
      location.store.normalizePath(directory) !== directory ||
      !(parent === location.directory || parent.endsWith('/' + location.directory))
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
    const listed = await location.listFiles();
    if (listed.truncated) throw new Error('Skill catalog is incomplete.');
    const prefix = directory + '/';
    const paths = new Set(listed.files.filter(path => path.startsWith(prefix)));
    if (paths.size > 256) throw new Error('Skill package exceeds 256 files.');
    const inventory = await inventoryFiles(root);
    if (inventory.length !== paths.size || inventory.some(path => !paths.has(prefix + path)))
      throw new Error('Package contains unindexed or unauthorized files. Refresh before managing it.');
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
  private async persist(entry: SkillTransaction) {
    if (entry.replacement) await this.state.record(entry.skillId, entry.source!, entry.replacement);
    else await this.state.forget(entry.skillId);
  }
  private async recoverLocation(location: SkillPackageLocation, root: string) {
    for (const entry of await this.journal.entries(root, location.id)) {
      const target = await this.target(location, entry.directory);
      const stage = join(await privateSkillDirectory(location.store.root), entry.id);
      if (entry.retired) {
        await this.finish(entry, stage);
        continue;
      }
      await location.assertClean?.(target);
      if (entry.published) {
        if ((await diskRevision(target)) !== entry.replacement)
          throw new Error('Package recovery is required. Published files changed at ' + target);
        await this.assertBackup(entry, stage);
        await this.persist(entry);
      } else await this.rollback(entry, stage, target);
      await this.finish(entry, stage);
    }
  }
  private async assertBackup(entry: SkillTransaction, stage: string) {
    if (entry.expected && (await diskRevision(join(stage, 'previous'))) !== entry.expected)
      throw new Error('Package recovery is required. Inspect retained staging at ' + stage);
  }
  private async finish(entry: SkillTransaction, stage: string) {
    // Record the decision before cleanup so an interruption can finish deleting only our private staging.
    if (!entry.retired) await this.journal.write({ ...entry, retired: true });
    await rm(stage, { recursive: true, force: true });
    await syncDirectory(dirname(stage));
    await this.journal.finish(entry.id);
  }
  private async rollback(entry: SkillTransaction, stage: string, target: string) {
    const backup = join(stage, 'previous');
    let saved: boolean;
    try {
      saved = !!(await optionalStat(backup));
    } catch (cause) {
      throw new Error('Package recovery is required. Inspect retained staging at ' + stage, { cause });
    }
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
      await rename(target, join(stage, 'reverted'));
    }
    if (saved) await rename(backup, target);
    await syncDirectory(dirname(target));
  }
  private async commit(change: Pending, signal?: AbortSignal) {
    const { location, directory, preview, files, expected } = change;
    const root = await location.store.resolvePath(location.directory);
    await this.recoverLocation(location, root);
    await location.refreshIndex();
    const current = await this.read(location, directory);
    if ((current.size > 0 ? packageRevision(current) : null) !== expected)
      throw new Error('The skill changed after preview. Preview it again.');
    const target = await this.target(location, directory);
    if (preview.destination.path !== target) throw new Error('The skill destination changed after preview.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const stage = join(await privateSkillDirectory(location.store.root), preview.id);
    await mkdir(stage, { mode: 0o700 });
    await syncDirectory(dirname(stage));
    const entry: SkillTransaction = {
      id: preview.id,
      root,
      location: location.id,
      directory,
      skillId: skillPackageId(location.id, directory),
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
      if (files) await stagePackage(join(stage, 'package'), files, signal);
      await location.assertClean?.(target);
      signal?.throwIfAborted();
      if (expected) {
        await rename(target, backup);
        await syncDirectory(stage);
        await syncDirectory(dirname(target));
        if ((await diskRevision(backup)) !== expected)
          throw new Error('The skill changed during replacement. Preview it again.');
      } else if (await optionalStat(target)) throw new Error('A skill appeared at the destination. Preview again.');
      signal?.throwIfAborted();
      if (files) await rename(join(stage, 'package'), target);
      await syncDirectory(dirname(target));
      await syncDirectory(stage);
      if ((await diskRevision(target)) !== entry.replacement) throw new Error('The skill changed during publication.');
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
        await this.rollback(entry, stage, target);
        await this.finish(entry, stage);
      } else await rm(stage, { recursive: true, force: true });
      throw error;
    }
    await this.finish(entry, stage);
  }
}
