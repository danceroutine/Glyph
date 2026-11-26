import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { posix } from 'node:path';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillDescriptor, SkillOrigin } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';
import { captureSkillPackage } from './SkillPackage.ts';
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
  readonly uriForPath: (path: string) => string;
  readonly refreshIndex: () => Promise<void>;
}

/** Discovers package metadata from Rust-indexed paths. File reads retain the store's policy and symlink guards. */
export class FileSkillDiscoveryProvider implements SkillDiscoveryProvider {
  readonly id: string;
  private paths: readonly string[] = [];
  constructor(private readonly location: SkillDiscoveryLocation) {
    this.id = location.origin.id;
  }

  async discover(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    signal?.throwIfAborted();
    const listed = await this.location.listFiles(signal);
    if (listed.truncated) throw new Error(`Skill discovery is incomplete for ${this.location.origin.label}.`);
    this.paths = listed.files;
    const directories = new Set<string>();
    for (const path of listed.files) {
      const marker = this.location.directory === '.' ? '' : `${this.location.directory}/`;
      const index = marker === '' ? 0 : path.startsWith(marker) ? 0 : path.indexOf(`/${marker}`) + 1;
      if (marker !== '' && !path.startsWith(marker, index)) continue;
      const name = path.slice(index + marker.length).split('/')[0];
      if (name && path.slice(index + marker.length).includes('/'))
        directories.add(`${path.slice(0, index)}${marker}${name}`);
    }
    // Native discovery can return large catalogs; bound metadata IO rather than opening every entry at once.
    const readDescriptor = async (directory: string): Promise<SkillDescriptor> => {
      const path = `${directory}/SKILL.md`;
      const name = posix.basename(directory);
      const source: SkillDescriptor = {
        id: `${this.id}:${directory}`,
        origin: this.location.origin,
        path,
        directory,
        scope:
          this.location.origin.scope === 'user'
            ? '.'
            : this.location.directory === '.'
              ? '.'
              : directory.slice(0, directory.lastIndexOf(this.location.directory)).replace(/\/$/u, '') || '.',
        name,
        description: '',
        enabled: true,
        status: 'active',
        allowedTools: [],
        uri: this.location.uriForPath(path),
      };
      try {
        signal?.throwIfAborted();
        const snapshot = await this.location.workspace.read(path, { maxBytes: 256 * 1024 });
        const manifest = parseSkillManifest(snapshot.text, name);
        return {
          ...source,
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
          status: 'error' as const,
          enabled: false,
          message: error instanceof Error ? error.message : 'Skill metadata is unavailable.',
        };
      }
    };
    const ordered = [...directories].toSorted();
    const descriptors: SkillDescriptor[] = [];
    for (let offset = 0; offset < ordered.length; offset += 8) {
      descriptors.push(
        ...(await Promise.all(ordered.slice(offset, offset + 8).map(directory => readDescriptor(directory)))),
      );
    }
    return descriptors.map(descriptor => ({
      ...descriptor,
      scope: this.location.scopePrefix
        ? descriptor.scope === '.'
          ? this.location.scopePrefix
          : `${this.location.scopePrefix}/${descriptor.scope}`
        : descriptor.scope,
    }));
  }

  capture(descriptor: SkillDescriptor, signal?: AbortSignal) {
    return captureSkillPackage(
      descriptor,
      this.location.workspace,
      this.paths.filter(path => path.startsWith(`${descriptor.directory}/`)),
      signal,
      this.location.binaryStore,
    );
  }

  refreshIndex(): Promise<void> {
    return this.location.refreshIndex();
  }
}
