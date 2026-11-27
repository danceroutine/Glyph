import { workspaceReadFailureBytes } from '#src/workspace/WorkspaceReadFailure.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import {
  AgentInstructionActivationMode,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';
import type { AgentInstructionSourceProvider } from '#src/instructions/AgentInstructionSourceProvider.js';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { AgentRuleFile } from './AgentRuleFile.ts';
import { MAX_AGENT_RULE_BYTES, parseAgentRuleFile } from './parseAgentRuleFile.ts';

const DEFAULT_MAX_FILES = 10_000;
const MAX_REFERENCE_DEPTH = 16;

export interface AgentRuleInstructionProviderOptions {
  readonly kind: Exclude<AgentInstructionSourceKind, AgentInstructionSourceKind.AGENTS_MD>;
  /** Directory below the store root that owns `rules/`. Use `.` for a store rooted at `~/.glyph`. */
  readonly directory: '.glyph' | '.cursor' | '.';
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly paths?: InstructionPaths;
  readonly maxReferenceEdges?: number;
  readonly maxExpandedBytes?: number;
  readonly maxDiscoveryBytes?: number;
  readonly maxDiscoveryReferenceEdges?: number;
  readonly displayPrefix?: string;
  readonly uriForPath?: (path: string) => string;
}

/** Discovers, parses, validates, and expands one family of file-backed rules. */
export class AgentRuleInstructionProvider implements AgentInstructionSourceProvider {
  private readonly paths: InstructionPaths;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly options: AgentRuleInstructionProviderOptions,
    private readonly listFiles: (
      maxFiles: number,
      globPattern: string,
    ) => Promise<{ files: string[]; truncated: boolean }> = (maxFiles, globPattern) =>
      workspace.list(maxFiles, globPattern),
  ) {
    this.paths = options.paths ?? new InstructionPaths(workspace.caseSensitive);
  }

  async discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    const pattern = this.options.directory === '.' ? 'rules/*.mdc' : `**/${this.options.directory}/rules/*.mdc`;
    let listed: { files: string[]; truncated: boolean };
    try {
      listed = await this.listFiles(this.options.maxFiles ?? DEFAULT_MAX_FILES, pattern);
    } catch (error) {
      signal?.throwIfAborted();
      return [
        this.errorSource(`${this.options.directory}/rules`, '.', describe(error, 'Rules could not be discovered.')),
      ];
    }
    const sources: AgentInstructionSource[] = [];
    const budget = {
      readBytes: this.options.maxDiscoveryBytes ?? 8 * 1024 * 1024,
      outputBytes: this.options.maxDiscoveryBytes ?? 8 * 1024 * 1024,
      reads: this.options.maxFiles ?? DEFAULT_MAX_FILES,
      edges: this.options.maxDiscoveryReferenceEdges ?? 8_192,
    };
    // Process one rule at a time in index order. Independent provider families can discover concurrently.
    for (const path of listed.files) {
      signal?.throwIfAborted();
      if (
        this.options.directory === '.' &&
        !/^rules\/[^/]+\.mdc$/u.test(this.paths.caseSensitive(path) ? path : path.toLowerCase())
      )
        continue;
      sources.push(await this.readRule(path, budget, signal));
    }
    if (listed.truncated)
      sources.push(
        this.errorSource(
          `${this.options.directory}/rules`,
          '.',
          `Rule discovery exceeded the ${this.options.maxFiles ?? DEFAULT_MAX_FILES}-file limit.`,
        ),
      );
    return sources;
  }

  private async readRule(path: string, budget: DiscoveryBudget, signal?: AbortSignal): Promise<AgentInstructionSource> {
    let normalized = path;
    let scope = '.';
    let name: string | undefined;
    const dependencies = new Set<string>();
    let sourceRevision: string | undefined;
    let uri: string | undefined;
    try {
      normalized = this.workspace.normalizePath(path);
      scope = ruleScope(normalized, this.options.directory, this.paths.caseSensitive(normalized));
      const snapshot = await this.read(normalized, budget);
      signal?.throwIfAborted();
      sourceRevision = snapshot.revision;
      uri = this.options.uriForPath?.(normalized);
      const parsed = parseAgentRuleFile(snapshot.text);
      name = parsed.name;
      const activation = resolveActivation(parsed.activation, parsed.alwaysApply, parsed.globs, parsed.description);
      if (activation === AgentInstructionActivationMode.MODEL && !parsed.description)
        throw new Error('Model-selected rules require a description.');
      if (activation === AgentInstructionActivationMode.FILE_PATTERN && parsed.globs.length === 0)
        throw new Error('Matching-files rules require at least one glob.');
      const { content, revision, references } = await this.expandRule(
        parsed,
        normalized,
        scope,
        snapshot.revision,
        dependencies,
        budget,
        signal,
      );
      return {
        ...this.paths.sourceIdentity(this.options.kind, normalized),
        kind: this.options.kind,
        label: label(this.options.kind),
        name: name ?? posix.parse(normalized).name,
        path: `${this.options.displayPrefix ?? ''}${normalized}`,
        scope,
        status: AgentInstructionSourceStatus.ACTIVE,
        content,
        revision,
        sourceRevision,
        activation,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.globs.length > 0 ? { globs: parsed.globs } : {}),
        enabled: parsed.enabled,
        ...(references.length > 0 ? { references } : {}),
        ...(uri ? { uri } : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...this.errorSource(normalized, scope, describe(error, 'Rule could not be read.')),
        ...(name ? { name } : {}),
        ...(sourceRevision ? { sourceRevision, revision: sourceRevision } : {}),
        ...(dependencies.size > 0 ? { references: [...dependencies] } : {}),
        ...(uri ? { uri } : {}),
      };
    }
  }

  private async expandRule(
    parsed: AgentRuleFile,
    normalized: string,
    scope: string,
    sourceRevision: string,
    dependencies: Set<string>,
    budget: DiscoveryBudget,
    signal?: AbortSignal,
  ) {
    const contents: string[] = [];
    const references: string[] = [];
    const revisions = [sourceRevision];
    const cache = new Map<string, { parsed: AgentRuleFile; revision: string }>();
    const ancestors = new Set([this.paths.key(normalized)]);
    let edges = 0;
    let remaining = Math.min(this.options.maxExpandedBytes ?? 256 * 1024, budget.outputBytes);
    const append = (value: string) => {
      const bytes = Buffer.byteLength(value) + (contents.length > 0 ? 2 : 0);
      if (bytes > remaining) throw new Error('Rule exceeds the expanded instruction byte limit.');
      remaining -= bytes;
      budget.outputBytes -= bytes;
      if (value) contents.push(value);
    };
    const expand = async (children: readonly string[]): Promise<void> => {
      if (ancestors.size > MAX_REFERENCE_DEPTH)
        throw new Error(`Rule references exceed ${MAX_REFERENCE_DEPTH} levels.`);
      for (const child of children) {
        signal?.throwIfAborted();
        if (++edges > (this.options.maxReferenceEdges ?? 128) || --budget.edges < 0)
          throw new Error('Rule reference count exceeds the discovery limit.');
        const target = this.workspace.normalizePath(this.paths.reference(scope, child));
        const key = this.paths.key(target);
        if (ancestors.has(key)) throw new Error(`Circular rule reference: ${[...ancestors, target].join(' -> ')}`);
        let entry = cache.get(key);
        if (!entry) {
          const reference = await this.read(target, budget, dependencies);
          signal?.throwIfAborted();
          entry = { parsed: parseAgentRuleFile(reference.text), revision: reference.revision };
          cache.set(key, entry);
        }
        append(`Referenced source (${target}):\n${entry.parsed.body}`);
        references.push(target);
        revisions.push(entry.revision);
        ancestors.add(key);
        await expand(entry.parsed.references);
        ancestors.delete(key);
      }
    };
    append(parsed.body);
    await expand(parsed.references);
    return {
      content: contents.join('\n\n'),
      references,
      revision: createHash('sha256').update(revisions.join('\0')).digest('hex'),
    };
  }

  private async read(
    path: string,
    budget: DiscoveryBudget,
    dependencies?: Set<string>,
  ): Promise<WorkspaceTextSnapshot> {
    const maxBytes = Math.min(this.options.maxBytes ?? MAX_AGENT_RULE_BYTES, budget.readBytes);
    // Source reads consume the file allowance and referenced reads consume the separate edge allowance.
    if (maxBytes <= 0 || (!dependencies && --budget.reads < 0))
      throw new Error('Instruction discovery read budget exhausted.');
    const snapshot = dependencies
      ? await this.workspace.readOptional(path, { maxBytes }).catch(async (error: unknown) => {
          // A bounded read checks store policy and file identity, including link restrictions,
          // before reporting a size limit. Track only an authorized name when its contents fail.
          budget.readBytes -= workspaceReadFailureBytes(error);
          const canWatch =
            error instanceof WorkspaceReadLimitError ||
            (await this.workspace.readOptional(path, { maxBytes: 0 }).then(
              () => true,
              (cause: unknown) => {
                budget.readBytes -= workspaceReadFailureBytes(cause);
                return cause instanceof WorkspaceReadLimitError;
              },
            ));
          if (canWatch) dependencies.add(path);
          throw error;
        })
      : await this.workspace.read(path, { maxBytes }).catch((error: unknown) => {
          budget.readBytes -= workspaceReadFailureBytes(error);
          throw error;
        });
    dependencies?.add(path);
    if (!snapshot) throw new Error(`Missing rule reference: ${path}`);
    budget.readBytes -= snapshot.byteLength ?? Buffer.byteLength(snapshot.text);
    return snapshot;
  }

  private errorSource(path: string, scope: string, message: string): AgentInstructionSource {
    return {
      ...this.paths.sourceIdentity(this.options.kind, path),
      kind: this.options.kind,
      label: label(this.options.kind),
      name: posix.parse(path).name,
      path: `${this.options.displayPrefix ?? ''}${path}`,
      scope,
      status: AgentInstructionSourceStatus.ERROR,
      message,
      enabled: false,
    };
  }
}

interface DiscoveryBudget {
  readBytes: number;
  outputBytes: number;
  reads: number;
  edges: number;
}

function ruleScope(path: string, directory: '.glyph' | '.cursor' | '.', sensitive: boolean): string {
  if (directory === '.') return '.';
  const segments = path.split('/');
  const location = segments.slice(-3).join('/');
  const normalized = sensitive ? location : location.toLowerCase();
  if (!normalized.startsWith(`${directory}/rules/`) || !normalized.endsWith('.mdc'))
    throw new Error(`Rule path is outside ${directory}/rules: ${path}`);
  return segments.slice(0, -3).join('/') || '.';
}

function resolveActivation(
  explicit: AgentInstructionActivationMode | undefined,
  alwaysApply: boolean | undefined,
  globs: readonly string[],
  description: string | undefined,
): AgentInstructionActivationMode {
  if (explicit) return explicit;
  if (alwaysApply === true) return AgentInstructionActivationMode.ALWAYS;
  if (globs.length > 0) return AgentInstructionActivationMode.FILE_PATTERN;
  if (description) return AgentInstructionActivationMode.MODEL;
  return AgentInstructionActivationMode.MANUAL;
}

function label(kind: AgentInstructionSourceKind): string {
  switch (kind) {
    case AgentInstructionSourceKind.GLYPH_PROJECT_RULE:
      return 'Glyph project rule';
    case AgentInstructionSourceKind.GLYPH_USER_RULE:
      return 'Glyph user rule';
    case AgentInstructionSourceKind.CURSOR_PROJECT_RULE:
      return 'Cursor-compatible rule';
    case AgentInstructionSourceKind.AGENTS_MD:
      return 'AGENTS.md';
  }
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
