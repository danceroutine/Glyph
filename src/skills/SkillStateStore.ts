import { z } from 'zod';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';

const schema = z.object({
  enabled: z.record(z.string(), z.boolean()),
  installations: z.record(z.string(), z.object({ source: z.string(), revision: z.string() })),
});
/** User-owned lifecycle preferences, keyed by stable package identity across workspace reloads. */
export class SkillStateStore {
  readonly enabled = new Map<string, boolean>();
  readonly installations = new Map<string, { source: string; revision: string }>();
  private queue = Promise.resolve();
  constructor(private readonly workspace: WorkspaceTextStore) {}
  async initialize(): Promise<void> {
    const snapshot = await this.workspace.readOptional('skill-state.json');
    if (!snapshot) return;
    const data = schema.parse(JSON.parse(snapshot.text));
    for (const [id, enabled] of Object.entries(data.enabled)) this.enabled.set(id, enabled);
    for (const [id, installation] of Object.entries(data.installations)) this.installations.set(id, installation);
  }
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.update(() => this.enabled.set(id, enabled));
  }
  record(id: string, source: string, revision: string): Promise<void> {
    return this.update(() => this.installations.set(id, { source, revision }));
  }
  forget(id: string): Promise<void> {
    return this.update(() => {
      this.enabled.delete(id);
      this.installations.delete(id);
    });
  }
  private update(change: () => unknown): Promise<void> {
    const operation = this.queue.then(async () => {
      const previous = await this.workspace.readOptional('skill-state.json');
      const enabled = new Map(this.enabled),
        installations = new Map(this.installations);
      if (previous) {
        const data = schema.parse(JSON.parse(previous.text));
        this.enabled.clear();
        this.installations.clear();
        for (const [id, value] of Object.entries(data.enabled)) this.enabled.set(id, value);
        for (const [id, value] of Object.entries(data.installations)) this.installations.set(id, value);
      }
      change();
      const text = JSON.stringify(
        { enabled: Object.fromEntries(this.enabled), installations: Object.fromEntries(this.installations) },
        null,
        2,
      );
      try {
        if (previous) await this.workspace.replace('skill-state.json', previous.revision, text, false);
        else await this.workspace.create('skill-state.json', text, false);
      } catch (error) {
        this.enabled.clear();
        this.installations.clear();
        for (const [key, value] of enabled) this.enabled.set(key, value);
        for (const [key, value] of installations) this.installations.set(key, value);
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
