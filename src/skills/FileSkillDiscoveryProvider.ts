import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { posix } from 'node:path';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillDescriptor, SkillOrigin } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';
import { captureSkillPackage } from './SkillPackage.ts';
import { skillPackageId } from './skillPackageId.ts';
import { parseSkillManifest } from './SkillManifest.ts';

/** Native and compatibility directories share a format but keep distinct location identities. */
export interface SkillDiscoveryLocation {
  readonly origin: SkillOrigin;
  readonly scopePrefix?: string;
  /** Store-relative directory. Nested occurrences are allowed for project locations. */
  readonly directory: string;
  readonly workspace: WorkspaceTextStore;
  readonly binaryStore?: Pick<FileSystemWorkspaceTextStore, 'readBytes'>;
  readonly listFiles: (
    signal?: AbortSignal,
  ) => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
  /** Optional package-scoped inventory for native indexes. */
  readonly captureFiles?: (directory: string, signal?: AbortSignal) => ReturnType<SkillDiscoveryLocation['listFiles']>;
  readonly uriForPath: (path: string) => string;
  readonly captureFiles?: (
    directory: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>;
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
    const readDescriptor = async ({
      directory,
      scope,
      manifest: indexedPath,
    }: IndexedSkillDirectory): Promise<SkillDescriptor> => {
      const path = indexedPath ?? `${directory}/SKILL.md`;
      const name = posix.basename(directory);
      const source: SkillDescriptor = {
        id: skillPackageId(this.id, directory),
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
        const snapshot = await this.location.workspace.read(path, { maxBytes: 256 * 1024 });
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
    const ordered = [...directories.values()].toSorted((left, right) => left.directory.localeCompare(right.directory));
    const descriptors: SkillDescriptor[] = [];
    for (let offset = 0; offset < ordered.length; offset += 8) {
      descriptors.push(
        ...(await Promise.all(ordered.slice(offset, offset + 8).map(directory => readDescriptor(directory)))),
      );
    }
    return descriptors;
  }

  async capture(descriptor: SkillDescriptor, signal?: AbortSignal) {
    const listed = await (this.location.captureFiles?.(descriptor.directory, signal) ??
      this.location.listFiles(signal));
    if (listed.truncated) throw new Error('Skill package inventory is incomplete.');
    return captureSkillPackage(
      descriptor,
      this.location.workspace,
      listed.files.filter(path => path.startsWith(`${descriptor.directory}/`)),
      signal,
      this.location.binaryStore,
    );
  }

  refreshIndex(): Promise<void> {
    return this.location.refreshIndex();
  }
}
