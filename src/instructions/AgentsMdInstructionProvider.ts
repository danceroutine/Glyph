import { posix } from 'node:path';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import {
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from './AgentInstructionSource.ts';
import type { AgentInstructionSourceProvider } from './AgentInstructionSourceProvider.ts';

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** Finds policy-authorized AGENTS.md files without walking outside the workspace store. */
export class AgentsMdInstructionProvider implements AgentInstructionSourceProvider {
  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly options: { readonly maxFiles?: number; readonly maxBytes?: number } = {},
    private readonly listFiles: (
      maxFiles: number,
      globPattern: string,
    ) => Promise<{ files: string[]; truncated: boolean }> = (maxFiles, globPattern) =>
      workspace.list(maxFiles, globPattern),
  ) {}

  async discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    let listed: { files: string[]; truncated: boolean };
    try {
      listed = await this.listFiles(this.options.maxFiles ?? DEFAULT_MAX_FILES, '**/AGENTS.md');
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      return [
        {
          id: `${AgentInstructionSourceKind.AGENTS_MD}:discovery-error`,
          kind: AgentInstructionSourceKind.AGENTS_MD,
          label: 'AGENTS.md discovery',
          path: 'AGENTS.md',
          scope: '.',
          status: AgentInstructionSourceStatus.ERROR,
          message: error instanceof Error ? error.message : 'Instruction files could not be discovered.',
        },
      ];
    }
    signal?.throwIfAborted();
    const sources = await Promise.all(
      listed.files.map(async (path): Promise<AgentInstructionSource> => {
        const normalized = this.workspace.normalizePath(path);
        const base = {
          id: `${AgentInstructionSourceKind.AGENTS_MD}:${normalized}`,
          kind: AgentInstructionSourceKind.AGENTS_MD,
          label: 'AGENTS.md',
          path: normalized,
          scope: instructionScope(normalized),
        } as const;
        try {
          const snapshot = await this.workspace.read(normalized, {
            maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
          });
          signal?.throwIfAborted();
          return {
            ...base,
            status: AgentInstructionSourceStatus.ACTIVE,
            content: snapshot.text,
            revision: snapshot.revision,
          } satisfies AgentInstructionSource;
        } catch (error) {
          if (signal?.aborted === true) throw signal.reason;
          return {
            ...base,
            status: AgentInstructionSourceStatus.ERROR,
            message: error instanceof Error ? error.message : 'Instruction file could not be read.',
          } satisfies AgentInstructionSource;
        }
      }),
    );
    if (listed.truncated) {
      sources.push({
        id: `${AgentInstructionSourceKind.AGENTS_MD}:discovery-limit`,
        kind: AgentInstructionSourceKind.AGENTS_MD,
        label: 'AGENTS.md discovery',
        path: 'AGENTS.md',
        scope: '.',
        status: AgentInstructionSourceStatus.ERROR,
        message: `Instruction discovery exceeded the ${this.options.maxFiles ?? DEFAULT_MAX_FILES}-file limit.`,
      });
    }
    return sources.toSorted(compareSources);
  }
}

function instructionScope(path: string): string {
  return posix.dirname(path);
}

function compareSources(left: AgentInstructionSource, right: AgentInstructionSource): number {
  return left.scope.split('/').length - right.scope.split('/').length || left.path.localeCompare(right.path);
}
