import { Duplex, PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import type { WorkspacePathIndex } from '../../context/search/WorkspacePathIndex.ts';
import { TerminalActionType } from '../TerminalActionType.ts';
import { TERMINAL_COMMANDS } from '../TerminalCommand.ts';
import { TerminalUI } from '../TerminalUI.tsx';

describe(TerminalUI, () => {
  describe(TerminalUI.prototype.nextAction, () => {
    it('parses ordinary prompts through the plain redirected-IO fallback', async () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const action = ui.nextAction(new AbortController().signal);

      input.write('hello there\n');

      await expect(action).resolves.toEqual({
        type: TerminalActionType.SEND,
        prompt: 'hello there',
        attachmentPaths: [],
      });
      ui.close();
    });

    it.each(TERMINAL_COMMANDS)('parses $value from the shared command catalog', async command => {
      const input = new PassThrough();
      const ui = new TerminalUI(input, new MemoryOutput(false), new MemoryOutput(false));
      const action = ui.nextAction(new AbortController().signal);

      input.write(`${command.value}\n`);

      await expect(action).resolves.toEqual(command.action);
      ui.close();
    });

    it('uses the shared command catalog in help output', () => {
      for (const command of TERMINAL_COMMANDS) expect(TerminalUI.help).toContain(command.value);
    });

    it('uses one Ink-owned input path for a wrapped prompt', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true, 28);
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));
      const action = ui.nextAction(new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      await type(terminal, 'this is a deliberately long prompt that wraps');
      terminal.push('\r');

      await expect(action).resolves.toMatchObject({
        type: TerminalActionType.SEND,
        prompt: 'this is a deliberately long prompt that wraps',
      });
      expect(terminal.rawTransitions).toContain(true);
      ui.close();
      expect(terminal.rawTransitions.at(-1)).toBe(false);
    });

    it('fuzzy-searches, attaches, and submits a project file from the Ink prompt', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true, 72);
      const queries: string[] = [];
      const files = fileSearch(async (query, { generation }) => {
        queries.push(query);
        return {
          generation,
          query,
          fileCount: 1,
          matches: [{ path: 'examples/todo-app/src/App.tsx', score: 10, indices: [22, 23, 24] }],
        };
      });
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false), files);
      const action = ui.nextAction(new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      await type(terminal, '@app');
      await waitUntil(() => queries.includes('app') && output.value.includes('examples/todo-app/src/App.tsx'));
      terminal.push('\r');
      await waitUntil(() => output.value.includes('@App.tsx'));
      await type(terminal, 'what does this file do?');
      terminal.push('\r');

      await expect(action).resolves.toEqual({
        type: TerminalActionType.SEND,
        prompt: '@examples/todo-app/src/App.tsx what does this file do?',
        attachmentPaths: ['examples/todo-app/src/App.tsx'],
      });
      ui.close();
    });

    it('removes an attachment when its mention is edited', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const files = fileSearch(async (query, { generation }) => ({
        generation,
        query,
        fileCount: 1,
        matches: [{ path: 'src/App.tsx', score: 10, indices: [4, 5, 6] }],
      }));
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false), files);
      const action = ui.nextAction(new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      await type(terminal, '@app');
      await waitUntil(() => output.value.includes('src/App.tsx'));
      terminal.push('\r');
      await waitUntil(() => output.value.includes('@App.tsx'));
      terminal.push('\x1b[D');
      await new Promise<void>(resolve => setImmediate(resolve));
      terminal.push('\x7f');
      await new Promise<void>(resolve => setImmediate(resolve));
      terminal.push('\x05');
      await new Promise<void>(resolve => setImmediate(resolve));
      terminal.push('\r');

      await expect(action).resolves.toEqual({
        type: TerminalActionType.SEND,
        prompt: '@src/App.ts',
        attachmentPaths: [],
      });
      ui.close();
    });
  });

  describe(TerminalUI.prototype.push, () => {
    it('renders reasoning summaries with proper section breaks in redirected output', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.beginAssistantResponse();
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Inspected ' });
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'the project.' });
      ui.push({ type: ChatResponsePartType.TEXT, value: 'The answer.' });
      ui.close();

      expect(output.value).toBe('thinking> Inspected the project.\n\nassistant> The answer.');
    });

    it('removes strong-emphasis delimiters from redirected reasoning summaries', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.beginAssistantResponse();
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: '**Planning** the edit.' });
      ui.close();

      expect(output.value).toBe('thinking> Planning the edit.');
    });

    it('renders structured tool errors instead of object coercion', () => {
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
            },
          }),
        },
      });
      ui.close();

      expect(output.value).toBe(
        '[project.propose_patch ×]\n  patch\n  Error: AMBIGUOUS: Patch context matches more than one location. ' +
          '(path=src/App.tsx; candidates=2, 8)\n',
      );
    });

    it('hides successful tool arguments and output in redirected output', () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));

      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: {
          phase: ToolActivityPhase.COMPLETED,
          name: 'read',
          callId: 'call',
          arguments: 'secret input',
          output: 'large successful result',
        },
      });
      ui.close();

      expect(output.value).toBe('[read ✓]\n');
    });

    it('gives streamed Ink response sections distinct visual hierarchy', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));

      ui.beginAssistantResponse();
      ui.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'Considering the change.\nChecking context.' });
      await waitUntil(() => stripVTControlCharacters(output.value).includes('Considering the change.'));
      ui.push({ type: ChatResponsePartType.TEXT, value: 'Done.' });
      await waitUntil(() => stripVTControlCharacters(output.value).includes('Done.'));
      ui.showTurnCompleted(1_000, null);
      await waitUntil(() => stripVTControlCharacters(output.value).includes('[1.0s | usage unavailable]'));

      const rendered = stripVTControlCharacters(output.value);
      expect(rendered).toContain('thinking> Considering the change.\nChecking context.');
      expect(rendered).toContain('Done.');
      expect(rendered).toContain('[1.0s | usage unavailable]');
      ui.close();
    });
  });

  describe(TerminalUI.prototype.present, () => {
    it('collects validated single, multiple, and Other answers through redirected IO', async () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const result = ui.present(
        {
          title: 'Decisions',
          questions: [question('single', false), question('multiple', true), question('other', false)],
        },
        new AbortController().signal,
      );

      await waitUntil(() => output.value.includes('Choice:'));
      input.write('3\n');
      await waitUntil(() => occurrences(output.value, 'Choose one of the listed options') === 1);
      input.write('2\n');
      await waitUntil(() => output.value.includes('Choices (comma-separated):'));
      input.write('1,3\n');
      await waitUntil(() => occurrences(output.value, 'Choose one of the listed options') === 2);
      input.write('1,2,1\n');
      await waitUntil(() => occurrences(output.value, 'Choice:') >= 3);
      input.write('o\n');
      await waitUntil(() => output.value.includes('Other:'));
      input.write('\n');
      await waitUntil(() => occurrences(output.value, 'Choose one of the listed options') === 3);
      input.write('o\n');
      await waitUntil(() => occurrences(output.value, 'Other:') === 2);
      input.write('Custom answer\n');

      await expect(result).resolves.toEqual({
        answers: [
          { questionId: 'single', type: 'SELECTION', optionIds: ['second'] },
          { questionId: 'multiple', type: 'SELECTION', optionIds: ['first', 'second'] },
          { questionId: 'other', type: 'OTHER', text: 'Custom answer' },
        ],
      });
      expect(output.value).toContain('Decisions');
      expect(output.value).toContain('Choices (comma-separated):');
      expect(output.value).toContain('Choose one of the listed options');
      ui.close();
    });

    it('presents an Ink question during a streamed response', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));
      ui.beginAssistantResponse();
      const result = ui.present({ questions: [question('single', false)] }, new AbortController().signal);

      await waitUntil(() => stripVTControlCharacters(output.value).includes('Choose for single'));
      terminal.push('\r');

      await expect(result).resolves.toEqual({
        answers: [{ questionId: 'single', type: 'SELECTION', optionIds: ['first'] }],
      });
      ui.close();
    });
  });

  describe('chat session presentation', () => {
    it('lists project chats, marks the active chat, and explains an empty catalog', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      const first = chatSummary('first-chat', 'First chat', 1);
      const second = chatSummary('second-chat', 'Second chat', 2);

      ui.showChats([], undefined);
      ui.showChats([first, second], second.id);
      ui.close();

      expect(output.value).toContain('No saved chats are available');
      expect(output.value).toContain('  first-ch  First chat  · 1 turn');
      expect(output.value).toContain('› second-c  Second chat  · 2 turns');
      expect(output.value).toContain('Use /chat <ID> to switch.');
    });

    it('replays the visible transcript and confirms human-authored names', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));

      ui.showChatActivated(chatSummary('chat-123456', 'Saved work', 2), [
        {
          userText: 'First question',
          attachmentPaths: [],
          reasoningSummary: 'Checked context',
          assistantText: 'First answer',
          createdAt: '2026-10-06T00:00:00.000Z',
        },
        {
          userText: 'Second question',
          attachmentPaths: [],
          reasoningSummary: '',
          assistantText: 'Second answer',
          createdAt: '2026-10-06T00:00:01.000Z',
        },
      ]);
      ui.showChatActivated(chatSummary('empty-chat', 'New chat', 0), []);
      ui.showChatRenamed('Human title');
      ui.close();

      expect(output.value).toContain('Chat chat-123  Saved work  · model');
      expect(output.value).toContain('you> First question\nthinking> Checked context\nassistant> First answer');
      expect(output.value).toContain('you> Second question\nassistant> Second answer');
      expect(output.value).toContain('Chat empty-ch  New chat  · model');
      expect(output.value).toContain('Chat renamed to "Human title".');
    });

    it('replaces the Ink transcript when a new chat is activated', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));

      ui.showChatActivated(chatSummary('old-chat', 'Old chat', 1), [
        {
          userText: 'Old question',
          attachmentPaths: [],
          reasoningSummary: '',
          assistantText: 'Old answer',
          createdAt: '2026-10-06T00:00:00.000Z',
        },
      ]);
      ui.showChatActivated(chatSummary('new-chat', 'New chat', 0), []);

      await waitUntil(() => stripVTControlCharacters(output.value).includes('Chat new-chat  New chat  · model'));
      const renderer = (ui as unknown as { renderer: { entries: unknown[] } }).renderer;
      expect(renderer.entries).toHaveLength(1);
      ui.close();
    });
  });
});

function chatSummary(id: string, title: string, turnCount: number) {
  return {
    schemaVersion: 2 as const,
    id,
    title,
    titleOrigin: 'generated' as const,
    projectContextId: 'project-context',
    accountClientId: 'client',
    accountSubject: 'subject',
    modelSlug: 'model',
    modelName: 'Model',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    turnCount,
  };
}

function question(id: string, allowMultiple: boolean) {
  return {
    id,
    prompt: `Choose for ${id}.`,
    options: [
      { id: 'first', label: 'First' },
      { id: 'second', label: 'Second' },
    ],
    allowMultiple,
  };
}

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

class MemoryOutput extends Writable {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows = 24;
  value = '';

  constructor(isTTY: boolean, columns = 80) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += String(chunk);
    callback();
  }
}

function fileSearch(search: WorkspacePathIndex['search']): WorkspacePathIndex {
  return {
    initialize: async () => ({
      root: '/project',
      fileCount: 0,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    }),
    search,
    glob: async () => ({ files: [], truncated: false }),
    searchContents: async () => ({
      outputMode: 'files_with_matches',
      files: [],
      searchedFiles: 0,
      skippedFiles: 0,
      indexTruncated: false,
      truncated: false,
      nextOffset: null,
    }),
    refresh: async () => ({
      root: '/project',
      fileCount: 0,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    }),
    dispose: async () => {},
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not reached.');
}

async function type(terminal: VirtualTTY, value: string): Promise<void> {
  for (const character of value) {
    terminal.push(character);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
