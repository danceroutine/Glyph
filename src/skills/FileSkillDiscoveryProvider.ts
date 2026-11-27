import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceTextDecodingError } from '#src/workspace/WorkspaceTextDecodingError.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { posix } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillDescriptor, SkillOrigin } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';
import { packageRevision } from './skillPackageRevision.ts';
import { captureSkillPackage, readSkillPackageFiles } from './SkillPackage.ts';
import { skillPackageId } from './skillPackageId.ts';
import { parseSkillManifest } from './SkillManifest.ts';

/** Native and compatibility directories share a format but keep distinct location identities. */
export interface SkillDiscoveryLocation {
  readonly origin: SkillOrigin;
  readonly scopePrefix?: string;
  /** Store-relative directory. Nested occurrences are allowed for project locations. */
  readonly directory: string;
  readonly workspace: WorkspaceTextStore;
  readonly binaryStore?: Pick<FileSystemWorkspaceTextStore, 'readBytes'> &
    Partial<Pick<FileSystemWorkspaceTextStore, 'resolvePath'>>;
  readonly listFiles: (signal?: AbortSignal) => Promise<{
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly directories?: ReadonlyMap<string, number>;
  }>;
  readonly includeDirectory?: (directory: string) => boolean;
  readonly packageId?: (directory: string) => string;
  readonly matchesLegacyId?: (directory: string, id: string, budget: { remaining: number }) => boolean;
  readonly uriForPath: (path: string) => string;
  /** Optional package-scoped inventory for native indexes. */
  readonly captureFiles?: (
    directory: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly directories?: ReadonlyMap<string, number>;
  }>;
  readonly refreshIndex: () => Promise<void>;
}

interface IndexedSkillDirectory {
  readonly directory: string;
  readonly scope: string;
  manifest?: string;
}

/** Discovers package metadata from Rust-indexed paths. File reads retain the store's policy and symlink guards. */
export class FileSkillDiscoveryProvider implements SkillDiscoveryProvider {
  readonly origin: SkillOrigin;
  readonly id: string;
  constructor(private readonly location: SkillDiscoveryLocation) {
    this.origin = location.origin;
    this.id = this.origin.id;
  }

  matchesLegacyId(directory: string, id: string, budget: { remaining: number }): boolean {
    return this.location.matchesLegacyId?.(directory, id, budget) ?? false;
  }

  scopePathKey(path: string): string {
    if (this.location.workspace.caseSensitive) return path;
    if (!this.location.scopePrefix) return path.toLowerCase();
    const [root, ...relative] = path.split('/');
    return [root, ...relative.map(segment => segment.toLowerCase())].join('/');
  }

  async discover(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    signal?.throwIfAborted();
    const listed = await this.location.listFiles(signal);
    if (listed.truncated) throw new Error(`Skill discovery is incomplete for ${this.location.origin.label}.`);
    const marker = this.location.directory === '.' ? [] : this.location.directory.split('/');
    const key = (name: string) => (this.location.workspace.caseSensitive ? name : name.toLowerCase());
    const directories = new Map<string, IndexedSkillDirectory>();
    for (const path of listed.files) {
      const segments = path.split('/');
      const start =
        marker.length === 0
          ? 0
          : segments.findIndex((_, i) => marker.every((segment, j) => key(segments[i + j] ?? '') === key(segment)));
      const packageIndex = start + marker.length;
      if (start < 0 || !segments[packageIndex] || segments.length < packageIndex + 2) continue;
      const directory = segments.slice(0, packageIndex + 1).join('/');
      const scope = this.origin.scope === 'project' ? segments.slice(0, start).join('/') : '';
      const entry = directories.get(directory) ?? {
        directory,
        scope: [this.location.scopePrefix, scope].filter(Boolean).join('/') || '.',
      };
      if (segments.length === packageIndex + 2 && key(segments[packageIndex + 1]!) === key('SKILL.md'))
        entry.manifest = path;
      directories.set(directory, entry);
    }
    // Bound metadata reads across large native catalogs.
    let remainingBytes = 8 * 1024 * 1024;
    const maxManifestBytes = 256 * 1024;
    const readDescriptor = async ({
      directory,
      scope,
      manifest: indexedPath,
    }: IndexedSkillDirectory): Promise<SkillDescriptor> => {
      const path = indexedPath ?? `${directory}/SKILL.md`;
      const name = posix.basename(directory);
      const source: SkillDescriptor = {
        id: this.location.packageId?.(directory) ?? skillPackageId(this.id, directory),
        origin: this.location.origin,
        path,
        directory,
        scope,
        name,
        description: '',
        enabled: true,
        status: 'active',
        allowedTools: [],
        uri: '',
      };
      let uri = '';
      try {
        signal?.throwIfAborted();
        if (!indexedPath) throw new Error('Skill package has no indexed SKILL.md.');
        const maxBytes = Math.min(remainingBytes, maxManifestBytes);
        if (maxBytes <= 0) throw new Error('Skill metadata exceeds the 8 MiB discovery budget.');
        remainingBytes -= maxBytes;
        const snapshot = await this.location.workspace.read(path, { maxBytes }).catch((error: unknown) => {
          const bytesRead =
            error instanceof WorkspaceTextDecodingError || error instanceof WorkspaceReadLimitError
              ? error.bytesRead
              : 0;
          remainingBytes += Math.max(0, maxBytes - bytesRead);
          throw error;
        });
        remainingBytes += maxBytes - snapshot.byteLength;
        uri = this.location.uriForPath(path);
        const manifest = parseSkillManifest(snapshot.text, name);
        return {
          ...source,
          uri,
          name: manifest.name,
          description: manifest.description,
          revision: snapshot.revision,
          allowedTools: manifest.allowedTools,
          ...(manifest.compatibility ? { compatibility: manifest.compatibility } : {}),
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return {
          ...source,
          uri,
          status: 'error' as const,
          enabled: false,
          message: error instanceof Error ? error.message : 'Skill metadata is unavailable.',
        };
      }
    };
    const ordered = [...directories.values()]
      .filter(entry => this.location.includeDirectory?.(entry.directory) !== false)
      .toSorted((left, right) => left.directory.localeCompare(right.directory));
    const descriptors: SkillDescriptor[] = [];
    for (let offset = 0; offset < ordered.length;) {
      const width = Math.min(8, Math.max(1, Math.floor(remainingBytes / maxManifestBytes)));
      descriptors.push(
        ...(await Promise.all(ordered.slice(offset, offset + width).map(directory => readDescriptor(directory)))),
      );
      offset += width;
    }
    return descriptors;
  }

  async capture(descriptor: SkillDescriptor, signal?: AbortSignal, reconcile?: () => Promise<void>) {
    const inventory = async () => {
      if (!this.location.captureFiles) await this.location.refreshIndex();
      const listed = await (this.location.captureFiles?.(descriptor.directory, signal) ??
        this.location.listFiles(signal));
      if (listed.truncated) throw new Error('Skill package inventory is incomplete.');
      return {
        paths: listed.files.filter(path => path.startsWith(descriptor.directory + '/')).toSorted(),
        directories: listed.directories,
      };
    };
    const directory = await this.location.binaryStore?.resolvePath?.(descriptor.directory);
    // Replacing the package directory changes its filesystem identity even when a manifest is identical.
    const generation = async () => {
      if (!directory) return;
      const stat = await lstat(directory, { bigint: true });
      return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join('/');
    };
    const initialGeneration = await generation();
    const { paths, directories } = await inventory();
    const snapshot = await captureSkillPackage(
      descriptor,
      this.location.workspace,
      paths,
      signal,
      this.location.binaryStore,
      directories,
    );
    if (reconcile) await reconcile();
    // Re-read every authorized file and both inventory boundaries before admitting this revision.
    const verified = await readSkillPackageFiles(
      descriptor,
      this.location.workspace,
      paths,
      signal,
      this.location.binaryStore,
    );
    const finalPaths = await inventory();
    if (
      initialGeneration !== (await generation()) ||
      packageRevision(verified, finalPaths.directories) !== snapshot.revision ||
      JSON.stringify(paths) !== JSON.stringify(finalPaths.paths)
    )
      throw new Error('The skill changed during capture. Refresh and activate it again.');
    return snapshot;
  }

  refreshIndex(): Promise<void> {
    return this.location.refreshIndex();
  }
}
