import { withPrivateFileLock } from '#src/workspace/withPrivateFileLock.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_AGENT_RULE_BYTES, parseAgentRuleFile } from './parseAgentRuleFile.ts';
import { withRuleEnabled } from './ruleFrontmatter.ts';
import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';

export type UserAgentRuleActivation = 'always' | 'file_pattern' | 'model' | 'manual';

/** Revision-guarded lifecycle operations for rules owned by the current user. */
export class UserAgentRuleManager {
  constructor(
    private readonly workspace: Pick<
      FileSystemWorkspaceTextStore,
      'root' | 'caseSensitive' | 'read' | 'create' | 'delete' | 'normalizePath' | 'replace'
    >,
    private readonly catalog: Pick<AgentInstructionCatalog, 'refresh'>,
    private readonly pathIndex?: Pick<RustWorkspacePathIndex, 'refresh' | 'assertReplaceableMetadata'>,
  ) {}

  get directoryUri(): string {
    return pathToFileURL(join(this.workspace.root, 'rules')).href;
  }

  async create(name: string, activation: UserAgentRuleActivation, condition?: string): Promise<void> {
    const title = name.trim();
    if (!title) throw new Error('Rule name cannot be empty.');
    const slug = title
      .toLocaleLowerCase('en-US')
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 80);
    if (!slug) throw new Error('Rule name must contain a letter or number.');
    const path = `rules/${slug}.mdc`;
    const metadata = [`name: ${JSON.stringify(title)}`, `activation: ${activation}`, 'enabled: true'];
    if (activation === 'model') {
      if (!condition?.trim()) throw new Error('Enter a description for model selection.');
      metadata.push(`description: ${JSON.stringify(condition.trim())}`);
    }
    if (activation === 'file_pattern') {
      const globs = condition
        ?.split(/\r?\n/u)
        .map(glob => glob.trim())
        .filter(Boolean);
      if (!globs?.length) throw new Error('Enter at least one file glob.');
      metadata.push('globs:', ...globs.map(glob => `  - ${JSON.stringify(glob)}`));
    }
    const text = ['---', ...metadata, '---', '', 'Describe the rule here.', ''].join('\n');
    if (Buffer.byteLength(text) > MAX_AGENT_RULE_BYTES) throw new Error('User rules can contain at most 64 KiB.');
    parseAgentRuleFile(text);
    await this.mutate(() => this.workspace.create(path, text, false));
    await this.refreshDiscovery();
  }

  async setEnabled(path: string, expectedRevision: string, enabled: boolean): Promise<void> {
    const normalized = this.rulePath(path);
    await this.mutate(async () => {
      const current = await this.workspace.read(normalized, { maxBytes: MAX_AGENT_RULE_BYTES });
      if (current.revision !== expectedRevision) throw new Error('The rule changed. Refresh Settings and try again.');
      const text = withRuleEnabled(current.text, enabled);
      if (Buffer.byteLength(text) + (current.byteOrderMark ? 3 : 0) > MAX_AGENT_RULE_BYTES)
        throw new Error('User rules can contain at most 64 KiB. Shorten the rule before changing its enablement.');
      const index = this.pathIndex;
      const metadata = index && {
        beforeReplace: () => index.assertReplaceableMetadata(normalized.slice('rules/'.length)),
      };
      await metadata?.beforeReplace();
      await this.workspace.replace(normalized, expectedRevision, text, current.byteOrderMark, metadata);
    });
    await this.refreshDiscovery();
  }

  async remove(path: string, expectedRevision: string): Promise<void> {
    const normalized = this.rulePath(path);
    await this.mutate(() => this.workspace.delete(normalized, expectedRevision));
    await this.refreshDiscovery();
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    return withPrivateFileLock(join(this.workspace.root, '.locks', 'user-rules.sqlite'), work);
  }

  /** Publish managed mutations immediately, without waiting for native watcher reconciliation. */
  private async refreshDiscovery(): Promise<void> {
    try {
      await this.pathIndex?.refresh();
      await this.catalog.refresh();
    } catch (error) {
      throw new Error(
        `The rule change was saved. Refresh Agent Instructions to see it. ${error instanceof Error ? error.message : ''}`.trim(),
        { cause: error },
      );
    }
  }

  private rulePath(path: string): string {
    const normalized = this.workspace.normalizePath(path);
    if (!/^rules\/[^/]+\.mdc$/u.test(this.workspace.caseSensitive ? normalized : normalized.toLowerCase()))
      throw new Error('Only user rules can be managed here.');
    return normalized;
  }
}

export { withRuleEnabled as withEnabled__TESTING_ONLY };
