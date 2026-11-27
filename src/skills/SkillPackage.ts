import { authorizeSources, type SourcePin } from '#src/workspace/SourceDisclosure.js';
import { packageRevision } from './skillPackageRevision.ts';
import { posix } from 'node:path';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillDescriptor, SkillResourceUse } from './SkillDescriptor.ts';
import { parseSkillManifest } from './SkillManifest.ts';

/** Immutable package revision pinned when a skill first activates. Resources are disclosed individually. */
export interface SkillPackageFile {
  readonly bytes: Uint8Array;
  /** Disk descriptor identity used to enroll the captured revision under the package's source authority. */
  readonly identity?: string;
  readonly revision: string;
  readonly mode: number;
}

export class SkillPackage {
  private readonly used = new Map<string, SkillResourceUse>();
  readonly revision: string;
  constructor(
    readonly descriptor: SkillDescriptor,
    readonly body: string,
    private readonly files: ReadonlyMap<string, SkillPackageFile>,
    private readonly directories: ReadonlyMap<string, number> = new Map(),
    private readonly origins: ReadonlyMap<string, SourcePin> = new Map(),
  ) {
    this.descriptor = structuredClone(descriptor);
    this.files = new Map([...files].map(([path, file]) => [path, { ...file, bytes: Uint8Array.from(file.bytes) }]));
    for (const [path, pin] of origins) {
      if (pin.file.identity !== this.files.get(path)?.identity)
        throw new Error('A skill resource changed during capture. Retry activation.');
    }
    this.directories = new Map(directories);
    this.revision = packageRevision(this.files, this.directories);
  }

  /** Defensive copy for host-owned lifecycle and execution staging. */
  packageFiles(): ReadonlyMap<string, SkillPackageFile> {
    return new Map([...this.files].map(([path, file]) => [path, { ...file, bytes: Uint8Array.from(file.bytes) }]));
  }
  packageDirectories(): ReadonlyMap<string, number> {
    return new Map(this.directories);
  }

  /** Return the manifest origin and the origins of only those resources included in a request.
   * A resource read checks its own route before its pinned bytes can enter a tool result or provenance. */
  disclosurePins(paths: readonly string[] = []): SourcePin[] {
    const manifest = posix.relative(this.descriptor.directory, this.descriptor.path);
    return [manifest, ...paths].flatMap(path => {
      const pin = this.origins.get(path);
      return pin ? [pin] : [];
    });
  }

  async readResource(path: string, signal?: AbortSignal, assertActive?: () => void): Promise<SkillResourceUse> {
    const resource = this.inspectResource(path);
    const check = await authorizeSources(this.disclosurePins([resource.path]), signal);
    check();
    assertActive?.();
    this.used.set(resource.path, resource);
    return resource;
  }

  inspectResource(path: string): SkillResourceUse {
    if (!path || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path) || path.split('/').includes('..'))
      throw new Error('Skill resource must remain inside its package.');
    const normalized = posix.normalize(path);
    const file = this.files.get(normalized);
    if (!file) throw new Error(`Skill resource is missing or unavailable: ${normalized}`);
    let content: string, encoding: 'utf8' | 'base64';
    try {
      content = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
      encoding = file.bytes.includes(0) ? 'base64' : 'utf8';
    } catch {
      content = '';
      encoding = 'base64';
    }
    if (encoding === 'base64') content = Buffer.from(file.bytes).toString('base64');
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Skill resource exceeds the 64 KiB disclosure budget.');
    return { path: normalized, revision: file.revision, content, encoding };
  }

  resources(): readonly SkillResourceUse[] {
    return [...this.used.values()];
  }
}

/** Capture one bounded package through the authorized store; never expand reference prose into model context. */
export async function captureSkillPackage(
  descriptor: SkillDescriptor,
  workspace: Pick<WorkspaceTextStore, 'read'>,
  paths: readonly string[],
  signal?: AbortSignal,
  binaryStore?: Pick<FileSystemWorkspaceTextStore, 'readBytes'>,
  directories?: ReadonlyMap<string, number>,
  origins?: ReadonlyMap<string, SourcePin>,
): Promise<SkillPackage> {
  const files = await readSkillPackageFiles(descriptor, workspace, paths, signal, binaryStore);
  const entry = files.get(posix.relative(descriptor.directory, descriptor.path));
  if (!entry) throw new Error('Skill package is missing SKILL.md.');
  if (descriptor.revision !== entry.revision) throw new Error('The skill changed. Refresh and activate it again.');
  const manifest = parseSkillManifest(new TextDecoder('utf8', { fatal: true }).decode(entry.bytes), descriptor.name);
  return new SkillPackage(descriptor, manifest.body, files, directories, origins);
}

export async function readSkillPackageFiles(
  descriptor: SkillDescriptor,
  workspace: Pick<WorkspaceTextStore, 'read'>,
  paths: readonly string[],
  signal?: AbortSignal,
  binaryStore?: Pick<FileSystemWorkspaceTextStore, 'readBytes'>,
): Promise<ReadonlyMap<string, SkillPackageFile>> {
  if (paths.length > 256) throw new Error('Skill package exceeds 256 files.');
  const files = new Map<string, SkillPackageFile>();
  let bytes = 0;
  for (const path of paths.toSorted()) {
    signal?.throwIfAborted();
    const relative = posix.relative(descriptor.directory, path);
    if (relative.startsWith('../') || relative === '..') throw new Error('Skill package path escaped its directory.');
    const raw = await binaryStore?.readBytes(path, { maxBytes: 1024 * 1024 });
    let text: string | undefined;
    if (raw) {
      try {
        text = new TextDecoder('utf8', { fatal: true }).decode(raw.bytes);
        if (raw.bytes.includes(0)) text = undefined;
      } catch {
        text = undefined;
      }
    }
    const snapshot = !raw || text !== undefined ? await workspace.read(path, { maxBytes: 1024 * 1024 }) : undefined;
    const captured = snapshot
      ? {
          bytes: Buffer.from(`${snapshot.byteOrderMark ? '\uFEFF' : ''}${snapshot.text}`, 'utf8'),
          identity: snapshot.identity,
          revision: snapshot.revision,
          mode: raw?.mode ?? snapshot.mode,
        }
      : raw!;
    bytes += captured.bytes.byteLength;
    if (bytes > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
    files.set(relative, captured);
  }
  return files;
}
