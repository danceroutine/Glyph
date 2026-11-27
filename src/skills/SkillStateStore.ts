import { inspectFileMetadata, type FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { inspectOwnerControlledDirectory, inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';
import type { WorkspaceReadOptions } from '#src/workspace/WorkspaceReadOptions.js';
import { constants } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { link, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { syncDirectory, withSkillLock } from './SkillPackageStorage.ts';

const schema = z.object({
  enabled: z.record(z.string(), z.boolean()),
  installations: z.record(z.string(), z.object({ source: z.string(), revision: z.string() })),
});
type Preferences = z.infer<typeof schema>;
function parsePreferences(text?: string): Preferences {
  return text === undefined ? { enabled: {}, installations: {} } : schema.parse(JSON.parse(text));
}
export class SkillPreferenceCommitUncertain extends Error {
  constructor(cause: unknown) {
    super('The skill preference write needs recovery. Check the user preferences and refresh Skills.', { cause });
  }
}
/** User-owned lifecycle preferences, keyed by stable package identity across workspace reloads. */
export class SkillStateStore {
  private serialized?: string;
  private readonly listeners = new Set<() => void>();
  readonly enabled = new Map<string, boolean>();
  readonly installations = new Map<string, { source: string; revision: string }>();
  constructor(
    private readonly workspace: FileSystemWorkspaceTextStore,
    readonly metadata: FilesystemMetadata,
  ) {}
  get userDirectory(): string {
    return this.workspace.root;
  }
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async initialize(): Promise<void> {
    await inspectOwnerControlledDirectory(this.metadata, this.userDirectory);
    await withSkillLock(this.metadata, this.userDirectory, 'preferences', async () => {
      await inspectOwnerControlledDirectory(this.metadata, this.userDirectory);
      this.publish(parsePreferences((await this.readPreferences())?.text));
    });
  }
  async migratePackageIds(aliases: ReadonlyMap<string, readonly string[]>): Promise<void> {
    const pending = [...aliases].filter(([, ids]) =>
      ids.some(id => this.enabled.has(id) || this.installations.has(id)),
    );
    if (pending.length === 0) return;
    await this.update(next => {
      for (const [current, ids] of pending) {
        const choices = ids.flatMap(id => (id in next.enabled ? [next.enabled[id]!] : []));
        if (!(current in next.enabled) && choices.length > 0) next.enabled[current] = choices.every(Boolean);
        for (const id of ids) {
          if (next.installations[id]) next.installations[current] ??= next.installations[id];
          delete next.enabled[id];
          delete next.installations[id];
        }
      }
    });
  }
  setEnabled(id: string, enabled: boolean, verifySource?: () => Promise<void>): Promise<void> {
    return this.update(next => {
      next.enabled[id] = enabled;
    }, verifySource);
  }
  record(id: string, source: string, revision: string): Promise<void> {
    return this.update(next => {
      next.installations[id] = { source, revision };
    });
  }
  forget(id: string): Promise<void> {
    return this.update(next => {
      delete next.enabled[id];
      delete next.installations[id];
    });
  }
  private async update(change: (data: Preferences) => void, verifySource?: () => Promise<void>): Promise<void> {
    await inspectOwnerControlledDirectory(this.metadata, this.userDirectory);
    await withSkillLock(this.metadata, this.userDirectory, 'preferences', async () => {
      await inspectOwnerControlledDirectory(this.metadata, this.userDirectory);
      const previous = await this.readPreferences();
      await verifySource?.();
      const next = parsePreferences(previous?.text);
      change(next);
      const text = JSON.stringify(next, null, 2);
      const destination = await this.workspace.resolvePath('skill-state.json');
      const parent = dirname(destination);
      const stage = join(parent, '.skill-staging');
      const checkDirectories = async () => {
        await inspectOwnerControlledDirectory(this.metadata, parent);
        await inspectPrivateDirectory(this.metadata, stage);
      };
      await checkDirectories();
      if (previous) await this.inspectPreferencePath(destination);
      try {
        if (previous)
          await this.workspace.replace('skill-state.json', previous.revision, text, false, {
            temporaryDirectory: stage,
            beforeReplace: async stagedPath => {
              await checkDirectories();
              await this.inspectPreferencePath(destination);
              await inspectFileMetadata(this.metadata, stagedPath, 'replaceable');
            },
          });
        else {
          // An interrupted first write must leave either a complete JSON document or an absent preference file.
          const temporary = join(stage, randomUUID() + '.json');
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
              await this.metadata.inspect(handle, 'replaceable');
              await handle.writeFile(text);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await checkDirectories();
            await inspectFileMetadata(this.metadata, temporary, 'replaceable');
            await link(temporary, destination);
          } finally {
            await rm(temporary, { force: true });
          }
        }
      } catch (error) {
        // A filesystem acknowledgement can fail after publication. Reconcile before returning a failed commit.
        let observed: string | undefined;
        try {
          observed = (await this.readPreferences())?.text;
        } catch (cause) {
          throw new SkillPreferenceCommitUncertain(cause);
        }
        if (observed !== text) throw error;
      }
      try {
        await inspectOwnerControlledDirectory(this.metadata, parent);
        const handle = await open(destination, 'r');
        try {
          await this.inspectPreference(handle);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(dirname(destination));
      } catch (cause) {
        throw new SkillPreferenceCommitUncertain(cause);
      }
      this.publish(next);
    });
  }
  private async inspectPreference(handle: FileHandle): Promise<void> {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))
    )
      throw new Error('Skill preferences must belong to the current user and must not be writable by other users.');
    await this.metadata.inspect(handle, 'replaceable');
  }

  private async inspectPreferencePath(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await this.inspectPreference(handle);
    } finally {
      await handle.close();
    }
  }

  private async readPreferences() {
    await inspectOwnerControlledDirectory(this.metadata, this.userDirectory);
    const options = {
      maxBytes: 1024 * 1024,
      metadata: { inspect: (handle: FileHandle) => this.inspectPreference(handle) },
    };
    return this.workspace.readOptional('skill-state.json', options);
  }

  private publish(data: Preferences): void {
    const serialized = JSON.stringify(data);
    if (this.serialized === serialized) return;
    this.serialized = serialized;
    this.enabled.clear();
    this.installations.clear();
    for (const [id, enabled] of Object.entries(data.enabled)) this.enabled.set(id, enabled);
    for (const [id, installation] of Object.entries(data.installations)) this.installations.set(id, installation);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A disconnected observer cannot undo an acknowledged profile write or starve the other catalogs.
      }
    }
  }
}
