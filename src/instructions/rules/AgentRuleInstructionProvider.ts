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
import { parseAgentRuleFile } from './parseAgentRuleFile.ts';

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_REFERENCE_DEPTH = 16;

export interface AgentRuleInstructionProviderOptions {
  readonly kind: Exclude<AgentInstructionSourceKind, AgentInstructionSourceKind.AGENTS_MD>;
  /** Directory below the store root that owns `rules/`. Use `.` for a store rooted at `~/.glyph`. */
  readonly directory: '.glyph' | '.cursor' | '.';
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly displayPrefix?: string;
  readonly uriForPath?: (path: string) => string;
}

/** Discovers, parses, validates, and expands one family of file-backed rules. */
export class AgentRuleInstructionProvider implements AgentInstructionSourceProvider {
  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly options: AgentRuleInstructionProviderOptions,
    private readonly listFiles: (
      maxFiles: number,
      globPattern: string,
    ) => Promise<{ files: string[]; truncated: boolean }> = (maxFiles, globPattern) =>
      workspace.list(maxFiles, globPattern),
  ) {}

  async discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    const pattern = this.options.directory === '.' ? 'rules/*.mdc' : `**/${this.options.directory}/rules/*.mdc`;
    let listed: { files: string[]; truncated: boolean };
    try {
      listed = await this.listFiles(this.options.maxFiles ?? DEFAULT_MAX_FILES, pattern);
    } catch (error) {
      return [
        this.errorSource(`${this.options.directory}/rules`, '.', describe(error, 'Rules could not be discovered.')),
      ];
    }
    const paths =
      this.options.directory === '.' ? listed.files.filter(path => /^rules\/[^/]+\.mdc$/u.test(path)) : listed.files;
    const sources = await Promise.all(paths.map(path => this.readRule(path, signal)));
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

  private async readRule(path: string, signal?: AbortSignal): Promise<AgentInstructionSource> {
    const normalized = this.workspace.normalizePath(path);
    const scope = ruleScope(normalized, this.options.directory);
    try {
      // TODO: Revisit instruction byte budgets: coordinate per-file limits with an
      // aggregate expanded-reference and per-turn budget instead of bounding each read alone.
      const snapshot = await this.workspace.read(normalized, { maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES });
      signal?.throwIfAborted();
      const parsed = parseAgentRuleFile(snapshot.text);
      const activation = resolveActivation(parsed.activation, parsed.alwaysApply, parsed.globs, parsed.description);
      const expanded = await this.expandReferences(
        parsed.body,
        parsed.references,
        scope,
        new Set([normalized]),
        signal,
      );
      const revision = createHash('sha256')
        .update([snapshot.revision, ...expanded.revisions].join('\0'))
        .digest('hex');
      return {
        id: `${this.options.kind}:${normalized}`,
        kind: this.options.kind,
        label: label(this.options.kind),
        name: parsed.name ?? posix.basename(normalized, '.mdc'),
        path: `${this.options.displayPrefix ?? ''}${normalized}`,
        scope,
        status: AgentInstructionSourceStatus.ACTIVE,
        content: [parsed.body, ...expanded.contents].filter(Boolean).join('\n\n'),
        revision,
        sourceRevision: snapshot.revision,
        activation,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.globs.length > 0 ? { globs: parsed.globs } : {}),
        enabled: parsed.enabled,
        ...(expanded.paths.length > 0 ? { references: expanded.paths } : {}),
        ...(this.options.uriForPath ? { uri: this.options.uriForPath(normalized) } : {}),
      };
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      return this.errorSource(normalized, scope, describe(error, 'Rule could not be read.'));
    }
  }

  private async expandReferences(
    body: string,
    references: readonly string[],
    scope: string,
    visited: Set<string>,
    signal?: AbortSignal,
  ): Promise<{ contents: string[]; paths: string[]; revisions: string[] }> {
    if (visited.size > MAX_REFERENCE_DEPTH) throw new Error(`Rule references exceed ${MAX_REFERENCE_DEPTH} levels.`);
    const result = { contents: [] as string[], paths: [] as string[], revisions: [] as string[] };
    for (const reference of references) {
      signal?.throwIfAborted();
      const path = this.workspace.normalizePath(scope === '.' ? reference : posix.join(scope, reference));
      if (visited.has(path)) throw new Error(`Circular rule reference: ${[...visited, path].join(' -> ')}`);
      const snapshot = await this.workspace.readOptional(path, {
        maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      if (!snapshot) throw new Error(`Missing rule reference: ${path}`);
      const nextVisited = new Set(visited).add(path);
      const parsed = parseAgentRuleFile(snapshot.text);
      const nested = await this.expandReferences(parsed.body, parsed.references, scope, nextVisited, signal);
      result.paths.push(path, ...nested.paths);
      result.revisions.push(snapshot.revision, ...nested.revisions);
      result.contents.push(`Referenced source (${path}):\n${parsed.body}`, ...nested.contents);
    }
    return result;
  }

  private errorSource(path: string, scope: string, message: string): AgentInstructionSource {
    const normalized = `${this.options.displayPrefix ?? ''}${path}`;
    return {
      id: `${this.options.kind}:${normalized}:error`,
      kind: this.options.kind,
      label: label(this.options.kind),
      name: posix.basename(path, '.mdc'),
      path: normalized,
      scope,
      status: AgentInstructionSourceStatus.ERROR,
      message,
      enabled: false,
      ...(this.options.uriForPath ? { uri: this.options.uriForPath(path) } : {}),
    };
  }
}

function ruleScope(path: string, directory: '.glyph' | '.cursor' | '.'): string {
  if (directory === '.') return '.';
  const marker = `/${directory}/rules/`;
  const index = path.indexOf(marker);
  if (index >= 0) return path.slice(0, index) || '.';
  const rootMarker = `${directory}/rules/`;
  if (path.startsWith(rootMarker)) return '.';
  throw new Error(`Rule path is outside ${directory}/rules: ${path}`);
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
