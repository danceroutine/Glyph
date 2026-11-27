import { inspectFileMetadata, type FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
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
    await withSkillLock(this.metadata, this.userDirectory, 'preferences', async () => {
      this.publish(parsePreferences((await this.workspace.readOptional('skill-state.json'))?.text));
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
    await withSkillLock(this.metadata, this.userDirectory, 'preferences', async () => {
      const previous = await this.workspace.readOptional('skill-state.json');
      await verifySource?.();
      const next = parsePreferences(previous?.text);
      change(next);
      const text = JSON.stringify(next, null, 2);
      const destination = await this.workspace.resolvePath('skill-state.json');
      const parent = dirname(destination);
      const stage = join(parent, '.skill-staging');
      const checkDirectories = async () => {
        await inspectFileMetadata(this.metadata, parent, 'access');
        await inspectPrivateDirectory(this.metadata, stage);
      };
      await checkDirectories();
      if (previous) await inspectFileMetadata(this.metadata, destination, 'replaceable');
      try {
        if (previous)
          await this.workspace.replace('skill-state.json', previous.revision, text, false, {
            temporaryDirectory: stage,
            beforeReplace: async stagedPath => {
              await checkDirectories();
              await inspectFileMetadata(this.metadata, destination, 'replaceable');
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
          observed = (await this.workspace.readOptional('skill-state.json'))?.text;
        } catch (cause) {
          throw new SkillPreferenceCommitUncertain(cause);
        }
        if (observed !== text) throw error;
      }
      try {
        const handle = await open(destination, 'r');
        try {
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
