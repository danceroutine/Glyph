import type { InstructionFileListing } from './listInstructionFilesAcrossRoots.ts';
import { defaultInstructionPaths, type InstructionPaths } from './InstructionPaths.ts';
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
    private readonly options: {
      readonly maxFiles?: number;
      readonly uriForPath?: (path: string) => string;
      readonly paths?: InstructionPaths;
      readonly maxBytes?: number;
      readonly maxDiscoveryBytes?: number;
    } = {},
    private readonly listFiles: (maxFiles: number, globPattern: string) => Promise<InstructionFileListing> = (
      maxFiles,
      globPattern,
    ) => workspace.list(maxFiles, globPattern),
  ) {}

  async discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    let listed: InstructionFileListing;
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
    const sources: AgentInstructionSource[] = (listed.failures ?? []).map(({ path, message }) => ({
      id: `${AgentInstructionSourceKind.AGENTS_MD}:discovery-error:${path}`,
      kind: AgentInstructionSourceKind.AGENTS_MD,
      label: 'AGENTS.md discovery',
      path,
      scope: instructionScope(path),
      status: AgentInstructionSourceStatus.ERROR,
      message,
    }));
    let remainingBytes = this.options.maxDiscoveryBytes ?? 8 * 1024 * 1024;
    for (const path of listed.files.toSorted((a, b) => a.split('/').length - b.split('/').length)) {
      signal?.throwIfAborted();
      let normalized = path;
      const base = () => ({
        ...(this.options.paths ?? defaultInstructionPaths).sourceIdentity(
          AgentInstructionSourceKind.AGENTS_MD,
          normalized,
        ),
        kind: AgentInstructionSourceKind.AGENTS_MD,
        label: 'AGENTS.md',
        path: normalized,
        scope: instructionScope(normalized),
      });
      try {
        normalized = this.workspace.normalizePath(path);
        if (remainingBytes <= 0) throw new Error('Instruction discovery read budget exhausted.');
        const snapshot = await this.workspace.read(normalized, {
          maxBytes: Math.min(remainingBytes, this.options.maxBytes ?? DEFAULT_MAX_BYTES),
        });
        signal?.throwIfAborted();
        remainingBytes -= snapshot.byteLength ?? Buffer.byteLength(snapshot.text);
        sources.push({
          ...base(),
          status: AgentInstructionSourceStatus.ACTIVE,
          ...(this.options.uriForPath ? { uri: this.options.uriForPath(normalized) } : {}),
          content: snapshot.text,
          revision: snapshot.revision,
        });
      } catch (error) {
        signal?.throwIfAborted();
        sources.push({
          ...base(),
          status: AgentInstructionSourceStatus.ERROR,
          message: error instanceof Error ? error.message : 'Instruction file could not be read.',
        });
      }
    }
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
