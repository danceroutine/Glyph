import { Duplex, PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { WorkspaceFileSearch } from '../../context/search/WorkspaceFileSearch.ts';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import { TerminalActionType } from '../TerminalActionType.ts';
import { TerminalInput } from '../TerminalInput.ts';
import { TerminalUI } from '../TerminalUI.ts';

class MemoryOutput extends Writable {
  readonly isTTY: boolean;
  value = '';

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += String(chunk);
    callback();
  }
}

describe(TerminalUI, () => {
  describe(TerminalUI.prototype.nextAction, () => {
    it('uses a prominent user prompt', async () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        const action = ui.nextAction(new AbortController().signal);
        input.write('hello\n');

        await expect(action).resolves.toEqual({
          type: TerminalActionType.SEND,
          prompt: 'hello',
          attachmentPaths: [],
        });
        expect(output.value).toContain('\u001b[1;36myou> \u001b[0m');
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }
    });

    it('fuzzy-searches and attaches a file after an at mention', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const input = new TerminalInput(terminal, output);
      const queries: Array<{ query: string; generation: number }> = [];
      const files: WorkspaceFileSearch = {
        initialize: async () => ({
          root: '/project',
          fileCount: 1,
          fromCache: false,
          truncated: false,
          durationMilliseconds: 0,
        }),
        search: async (query, options) => {
          queries.push({ query, generation: options.generation });
          return {
            generation: options.generation,
            query,
            fileCount: 1,
            matches: [{ path: 'src/App.tsx', score: 10, indices: [4, 5, 6] }],
          };
        },
        refresh: async () => ({
          root: '/project',
          fileCount: 1,
          fromCache: false,
          truncated: false,
          durationMilliseconds: 0,
        }),
        dispose: async () => {},
      };
      const ui = new TerminalUI(input, output, new MemoryOutput(false), files);
      const action = ui.nextAction(new AbortController().signal);

      terminal.push('@app');
      await waitUntil(() => queries.some(value => value.query === 'app') && output.value.includes('src/'));
      terminal.push('\r');
      await waitUntil(() => output.value.includes('attached: src/App.tsx'));
      terminal.push('\r');

      await expect(action).resolves.toEqual({
        type: TerminalActionType.SEND,
        prompt: '@src/App.tsx',
        attachmentPaths: ['src/App.tsx'],
      });
      const firstGeneration = Math.max(...queries.map(value => value.generation));

      const nextAction = ui.nextAction(new AbortController().signal);
      terminal.push('@app');
      await waitUntil(() => queries.some(value => value.query === 'app' && value.generation > firstGeneration));
      terminal.push('\r');
      await waitUntil(() => queries.some(value => value.generation > firstGeneration));
      terminal.push('\r');
      await expect(nextAction).resolves.toMatchObject({ type: TerminalActionType.SEND });
      expect(
        queries.filter(value => value.generation > firstGeneration).every(value => value.generation > firstGeneration),
      ).toBe(true);
      expect(terminal.rawTransitions.slice(-2)).toEqual([true, true]);
      ui.close();
    });

    it('removes an attachment when its mention is edited', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const input = new TerminalInput(terminal, output);
      const queries: string[] = [];
      const files = fileSearch(async (query, generation) => {
        queries.push(query);
        return {
          generation,
          query,
          fileCount: 1,
          matches: [{ path: 'src/App.tsx', score: 10, indices: [4, 5, 6] }],
        };
      });
      const ui = new TerminalUI(input, output, new MemoryOutput(false), files);
      const action = ui.nextAction(new AbortController().signal);

      terminal.push('@app');
      await waitUntil(() => queries.includes('app') && output.value.includes('src/App'));
      terminal.push('\r');
      await waitUntil(() => output.value.includes('attached: src/App.tsx'));
      terminal.push('\x1b[D\x7f\x05\r');

      await expect(action).resolves.toEqual({
        type: TerminalActionType.SEND,
        prompt: '@src/App.ts',
        attachmentPaths: [],
      });
      ui.close();
    });

    it('does not print an empty attachment label for an ordinary prompt', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const input = new TerminalInput(terminal, output);
      const ui = new TerminalUI(
        input,
        output,
        new MemoryOutput(false),
        fileSearch(async (query, generation) => ({
          generation,
          query,
          fileCount: 0,
          matches: [],
        })),
      );
      const action = ui.nextAction(new AbortController().signal);

      terminal.push('hello\r');

      await expect(action).resolves.toMatchObject({ prompt: 'hello', attachmentPaths: [] });
      expect(output.value).not.toContain('attached:');
      ui.close();
    });
  });

  describe(TerminalUI.prototype.push, () => {
    it('renders reasoning summaries as a subdued section before assistant text', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const errors = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, errors);
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        ui.beginAssistantResponse();
        ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Inspected ' });
        ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'the project.' });
        ui.push({ type: ChatResponsePartType.TEXT, value: 'The answer.' });
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }

      expect(output.value).toBe(
        '\u001b[2;90mthinking> \u001b[0m' +
          '\u001b[2;90mInspected \u001b[0m' +
          '\u001b[2;90mthe project.\u001b[0m' +
          '\n\n\u001b[1;32massistant> \u001b[0m' +
          '\u001b[32mThe answer.\u001b[0m',
      );
      expect(errors.value).toBe('');
    });

    it('does not emit color control sequences when output is not a terminal', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.beginAssistantResponse();
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Summary.' });
      ui.push({ type: ChatResponsePartType.TEXT, value: 'Answer.' });
      ui.close();

      expect(output.value).toBe('thinking> Summary.\n\nassistant> Answer.');
    });

    it('renders structured tool errors with their diagnostic details', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: {
          phase: ToolActivityPhase.COMPLETED,
          namespace: 'project',
          name: 'propose_patch',
          callId: 'call',
          arguments: 'patch',
          output: JSON.stringify({
            error: {
              code: 'AMBIGUOUS',
              message: 'Patch context matches more than one location.',
              path: 'src/App.tsx',
              candidates: [2, 8],
              retry: 'Include more unique context.',
            },
          }),
        },
      });
      ui.close();

      expect(output.value).toBe(
        '[tool< project.propose_patch error: AMBIGUOUS: Patch context matches more than one location. ' +
          '(path=src/App.tsx; candidates=2, 8; retry=Include more unique context.)]\n',
      );
    });

    it('gives tool calls a distinct hierarchy and outcome color', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const previousNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;

      try {
        ui.push({
          type: ChatResponsePartType.TOOL,
          activity: {
            phase: ToolActivityPhase.STARTED,
            namespace: 'project',
            name: 'propose_patch',
            callId: 'call',
            arguments: '*** Begin Patch\n*** End Patch\n',
          },
        });
        ui.push({
          type: ChatResponsePartType.TOOL,
          activity: {
            phase: ToolActivityPhase.COMPLETED,
            namespace: 'project',
            name: 'propose_patch',
            callId: 'call',
            arguments: '',
            output: '{"status":"STAGED_FOR_REVIEW"}',
          },
        });
      } finally {
        ui.close();
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
      }

      expect(output.value).toBe(
        '\u001b[33m[tool> project.propose_patch]\u001b[0m\n' +
          '\u001b[2m  *** Begin Patch\n  *** End Patch\u001b[0m\n' +
          '\u001b[32m[tool< project.propose_patch completed]\u001b[0m\n',
      );
    });
  });
});

class VirtualTTY extends Duplex {
  readonly isTTY = true;
  isRaw = false;
  readonly rawTransitions: boolean[] = [];
  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawTransitions.push(enabled);
  }
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Condition was not reached.');
}

function fileSearch(
  search: (query: string, generation: number) => ReturnType<WorkspaceFileSearch['search']>,
): WorkspaceFileSearch {
  const state = { root: '/project', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 0 };
  return {
    initialize: async () => state,
    search: (query, options) => search(query, options.generation),
    refresh: async () => state,
    dispose: async () => {},
  };
}
