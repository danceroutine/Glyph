import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';

export type UserAgentRuleActivation = 'always' | 'file_pattern' | 'model' | 'manual';

/** Revision-guarded lifecycle operations for rules owned by the current user. */
export class UserAgentRuleManager {
  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly catalog: Pick<AgentInstructionCatalog, 'refresh'>,
    private readonly pathIndex?: Pick<WorkspacePathIndex, 'refresh'>,
  ) {}

  async create(name: string, activation: UserAgentRuleActivation): Promise<void> {
    const title = name.trim();
    if (!title) throw new Error('Rule name cannot be empty.');
    const slug = title
      .toLocaleLowerCase('en-US')
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 80);
    if (!slug) throw new Error('Rule name must contain a letter or number.');
    const path = `rules/${slug}.mdc`;
    await this.workspace.create(
      path,
      `---\nname: ${yamlString(title)}\nactivation: ${activation}\nenabled: true\n---\n\nDescribe the rule here.\n`,
      false,
    );
    await this.refreshDiscovery();
  }

  async setEnabled(path: string, expectedRevision: string, enabled: boolean): Promise<void> {
    const normalized = this.rulePath(path);
    const current = await this.workspace.read(normalized);
    if (current.revision !== expectedRevision) throw new Error('The rule changed. Refresh Settings and try again.');
    await this.workspace.replace(
      normalized,
      expectedRevision,
      withEnabled(current.text, enabled),
      current.byteOrderMark,
    );
    await this.refreshDiscovery();
  }

  async remove(path: string, expectedRevision: string): Promise<void> {
    await this.workspace.delete(this.rulePath(path), expectedRevision);
    await this.refreshDiscovery();
  }

  /** Publish managed mutations immediately, without waiting for native watcher reconciliation. */
  private async refreshDiscovery(): Promise<void> {
    await this.pathIndex?.refresh();
    await this.catalog.refresh();
  }

  private rulePath(path: string): string {
    const normalized = this.workspace.normalizePath(path);
    if (!/^rules\/[^/]+\.mdc$/u.test(normalized)) throw new Error('Only user rules can be managed here.');
    return normalized;
  }
}

function withEnabled(text: string, enabled: boolean): string {
  if (!text.startsWith('---\n'))
    throw new Error('The rule needs YAML frontmatter before it can be enabled or disabled.');
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new Error('The rule has invalid YAML frontmatter.');
  const frontmatter = text.slice(4, end);
  const next = /^enabled\s*:/mu.test(frontmatter)
    ? frontmatter.replace(/^enabled\s*:.*$/mu, `enabled: ${enabled}`)
    : `${frontmatter}\nenabled: ${enabled}`;
  return `---\n${next}\n---${text.slice(end + 4)}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export { withEnabled as withEnabled__TESTING_ONLY };
