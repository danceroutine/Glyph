import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { ChatBackendPresentation } from '#src/chat/ChatBackend.js';
import type { Model } from '#src/chat/Model.js';
import type { Usage } from '#src/chat/Usage.js';
import { DiagnosticSeverity } from '#src/chat/DiagnosticSeverity.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { AccountSelectionType } from '#src/terminal/AccountSelectionType.js';
import { createProposalReviewFixture } from '#src/terminal/ui/proposal/test/ProposalReviewFixture.js';
import { TerminalInkRenderer } from '#src/terminal/ui/runtime/TerminalInkRenderer.js';
import type { TerminalOutputStream } from '#src/terminal/ui/runtime/TerminalOutputStream.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import { TerminalActionType } from '#src/terminal/TerminalActionType.js';
import { TERMINAL_COMMANDS } from '#src/terminal/TerminalCommand.js';
import { TerminalUI } from '#src/terminal/TerminalUI.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

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

    it.each([
      {
        name: 'Option+Left',
        before: '',
        shortcut: '\u001b[1;3D',
        insertion: 'X',
        expected: 'alpha Xbeta',
      },
      {
        name: 'Option+Right',
        before: '\u0001',
        shortcut: '\u001b[1;3C',
        insertion: 'X',
        expected: 'alphaX beta',
      },
      {
        name: 'Option+Backspace',
        before: '',
        shortcut: '\u001b\u007f',
        insertion: 'X',
        expected: 'alpha X',
      },
      {
        name: 'Option+Delete',
        before: '\u0001',
        shortcut: '\u001b[3;3~',
        insertion: 'X',
        expected: 'X beta',
      },
      {
        name: 'Cmd+Left',
        before: '',
        shortcut: '\u001b[1;9D',
        insertion: 'X',
        expected: 'Xalpha beta',
      },
      {
        name: 'Cmd+Right',
        before: '\u0001',
        shortcut: '\u001b[1;9C',
        insertion: 'X',
        expected: 'alpha betaX',
      },
      {
        name: 'Cmd+Backspace',
        before: '',
        shortcut: '\u001b[127;9u',
        insertion: 'X',
        expected: 'X',
      },
      {
        name: 'Cmd+Delete',
        before: '\u0001',
        shortcut: '\u001b[3;9~',
        insertion: 'X',
        expected: 'X',
      },
    ])('edits the prompt with $name terminal sequences', async ({ before, shortcut, insertion, expected }) => {
      const terminal = new VirtualTTY();
      const ui = new TerminalUI(terminal, new MemoryOutput(true), new MemoryOutput(false));
      const action = ui.nextAction(new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      await type(terminal, 'alpha beta');
      if (before) {
        terminal.push(before);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      terminal.push(shortcut);
      await new Promise<void>(resolve => setImmediate(resolve));
      await type(terminal, insertion);
      terminal.push('\r');

      await expect(action).resolves.toMatchObject({ type: TerminalActionType.SEND, prompt: expected });
      ui.close();
    });

    it('ignores Kitty key-release events', async () => {
      const terminal = new VirtualTTY();
      const ui = new TerminalUI(terminal, new MemoryOutput(true), new MemoryOutput(false));
      const action = ui.nextAction(new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('\u001b[120;1:3u');
      await new Promise<void>(resolve => setImmediate(resolve));
      terminal.push('\u000c');
      await new Promise<void>(resolve => setImmediate(resolve));
      await type(terminal, 'ok');
      terminal.push('\r');

      await expect(action).resolves.toMatchObject({ type: TerminalActionType.SEND, prompt: 'ok' });
      ui.close();
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

    it('sanitizes the complete tool error including codes, messages, and nested details in plain output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      try {
        ui.push({
          type: ChatResponsePartType.TOOL,
          activity: {
            phase: ToolActivityPhase.COMPLETED,
            name: 'read',
            callId: 'call',
            arguments: '',
            output: JSON.stringify({
              error: {
                code: '\u001b[35mEXCLUDED\u001b[0m',
                message: 'Denied\u0007',
                path: '.env\u001b[35msecret\u001b[0m',
                details: ['one\u202etwo'],
              },
            }),
          },
        });
        expect(output.value).toBe('[read ×]\n  Error: EXCLUDED: Denied (path=.envsecret; details=one\\u202etwo)\n');
      } finally {
        ui.close();
      }
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

  describe(TerminalUI.prototype.presentShellPermission, () => {
    it('validates and returns a redirected-IO approval choice', async () => {
      const input = new PassThrough();
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(input, output, new MemoryOutput(false));
      const result = ui.presentShellPermission(
        { command: 'pnpm test', workingDirectory: '/project' },
        new AbortController().signal,
      );

      await waitUntil(() => output.value.includes('Choice [1-6]'));
      input.write('invalid\n');
      await waitUntil(() => output.value.includes('Choose a number from 1 through 6'));
      input.write('5\n');

      await expect(result).resolves.toBe(ShellPermissionDecision.ALLOW_EVERYTHING);
      expect(output.value).toContain('Always allow this exact command');
      ui.close();
    });

    it('presents Ink approval during a response', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));
      ui.beginAssistantResponse();
      const result = ui.presentShellPermission(
        { command: 'pnpm test', workingDirectory: '/project' },
        new AbortController().signal,
      );

      await waitUntil(() => stripVTControlCharacters(output.value).includes('Shell permission required'));
      terminal.push('1');

      await expect(result).resolves.toBe(ShellPermissionDecision.ALLOW_ONCE);
      ui.close();
    });
  });

  describe(TerminalUI.prototype.connectShellSessions, () => {
    it('renders observed sessions, reports wakes, and stops every process on close', async () => {
      const terminal = new VirtualTTY();
      const output = new MemoryOutput(true);
      const shutdown = vi.fn();
      let listener: (() => void) | undefined;
      const stop = vi.fn();
      const manager = {
        sessions: [],
        onDidChange: vi.fn((value: () => void) => {
          listener = value;
          return stop;
        }),
        shutdown,
      } as unknown as ShellSessionManager;
      const ui = new TerminalUI(terminal, output, new MemoryOutput(false));
      ui.connectShellSessions(manager);
      (manager as unknown as { sessions: unknown[] }).sessions = [
        {
          id: 'terminal-one',
          workingDirectory: '/project',
          command: 'pnpm dev',
          status: ShellSessionStatus.RUNNING,
          background: true,
          outputTail: 'ready',
          startedAt: '2026-10-07T00:00:00.000Z',
        },
      ];
      listener?.();
      ui.showShellWake({
        id: 'wake',
        terminalId: 'terminal-one',
        pattern: 'ready',
        command: 'pnpm dev',
        workingDirectory: '/project',
        output: 'ready',
        matchedAt: '2026-10-07T00:00:00.000Z',
      });

      await waitUntil(() => stripVTControlCharacters(output.value).includes('Background terminals (1)'));
      expect(stripVTControlCharacters(output.value)).toContain('matched "ready"');
      ui.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(shutdown).toHaveBeenCalledOnce();
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

    it('replays a chat in Ink at the default width when the terminal reports no columns', () => {
      const { ui, renderer } = inkTerminal({ output: new ColumnlessOutput() });

      ui.showChatActivated(chatSummary('chat-123456', 'Saved work', 0), []);

      expect(renderer.replaceTranscript).toHaveBeenCalledOnce();
      expect(frame(renderer.replaceTranscript.mock.calls[0]?.[0])).toContain('Saved work');
    });
  });

  describe(TerminalUI.clean, () => {
    it('removes terminal control sequences from untrusted text', () => {
      expect(TerminalUI.clean('\u001b[31mred\u001b[0m')).toBe('red');
    });
  });

  describe(TerminalUI.prototype.on, () => {
    it('stops notifying an interrupt listener after it is removed', async () => {
      const input = new PassThrough();
      const ui = new TerminalUI(input, new MemoryOutput(true), new MemoryOutput(false));
      onTestFinished(() => ui.close());
      const removed = vi.fn();
      ui.on('SIGINT', removed);
      ui.off('SIGINT', removed);
      const interrupted = new Promise<void>(resolve => ui.on('SIGINT', resolve));
      void ui.confirmInferenceAccess('Enable?', new AbortController().signal);

      input.write('\u0003');

      await interrupted;
      expect(removed).not.toHaveBeenCalled();
    });

    it('forwards an interrupt requested by the Ink renderer', () => {
      const { ui, renderer } = inkTerminal();
      const listener = vi.fn();
      ui.on('SIGINT', listener);

      (renderer.setBackgroundShells.mock.contexts[0] as TerminalInkRenderer | undefined)?.requestInterrupt();

      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe(TerminalUI.prototype.onClose, () => {
    it('announces closure when redirected input ends', () => {
      const input = new PassThrough();
      const ui = new TerminalUI(input, new MemoryOutput(false), new MemoryOutput(false));
      onTestFinished(() => ui.close());
      const listener = vi.fn();
      ui.onClose(listener);

      input.emit('end');

      expect(listener).toHaveBeenCalledOnce();
    });

    it('announces closure when the Ink input ends', () => {
      const { ui, terminal } = inkTerminal();
      const listener = vi.fn();
      ui.onClose(listener);

      terminal.emit('end');

      expect(listener).toHaveBeenCalledOnce();
    });

    it('announces closure when a pending redirected prompt is closed', () => {
      const input = new PassThrough();
      const ui = new TerminalUI(input, new MemoryOutput(false), new MemoryOutput(false));
      const listener = vi.fn();
      ui.onClose(listener);
      void ui.confirmInferenceAccess('Enable?', new AbortController().signal);

      ui.close();

      expect(listener).toHaveBeenCalledOnce();
    });

    it('ignores the closure of a prompt reader that is no longer active', () => {
      const input = new PassThrough();
      const ui = new TerminalUI(input, new MemoryOutput(false), new MemoryOutput(false));
      onTestFinished(() => ui.close());
      const listener = vi.fn();
      ui.onClose(listener);
      void ui.confirmInferenceAccess('Enable?', new AbortController().signal);
      (ui as unknown as { reader: unknown }).reader = undefined;

      input.emit('end');

      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe(TerminalUI.prototype.close, () => {
    it('can be called more than once', () => {
      const shutdown = vi.fn();
      const ui = new TerminalUI(new PassThrough(), new MemoryOutput(false), new MemoryOutput(false), undefined, {
        sessions: [],
        onDidChange: () => () => {},
        shutdown,
      } as unknown as ShellSessionManager);

      ui.close();
      ui.close();

      expect(shutdown).toHaveBeenCalledOnce();
    });

    it('rejects prompts after the session is closed', async () => {
      const ui = new TerminalUI(new PassThrough(), new MemoryOutput(false), new MemoryOutput(false));
      ui.close();

      await expect(ui.confirmInferenceAccess('Enable?', new AbortController().signal)).rejects.toThrow(
        'Session closed.',
      );
    });
  });

  describe(TerminalUI.prototype.connectShellSessions, () => {
    it('coalesces background shell refreshes and cancels a pending refresh when replaced or closed', () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const firstListeners: (() => void)[] = [];
      const firstStop = vi.fn();
      const first = {
        sessions: [],
        onDidChange: (listener: () => void) => {
          firstListeners.push(listener);
          return firstStop;
        },
        shutdown: vi.fn(),
      } as unknown as ShellSessionManager;
      const secondListeners: (() => void)[] = [];
      const second = {
        sessions: [],
        onDidChange: (listener: () => void) => {
          secondListeners.push(listener);
          return () => {};
        },
        shutdown: vi.fn(),
      } as unknown as ShellSessionManager;
      const ui = new TerminalUI(new PassThrough(), new MemoryOutput(false), new MemoryOutput(false), undefined, first);

      firstListeners[0]?.();
      firstListeners[0]?.();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(50);
      expect(vi.getTimerCount()).toBe(0);
      firstListeners[0]?.();
      ui.connectShellSessions(second);
      expect(firstStop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      secondListeners[0]?.();
      expect(vi.getTimerCount()).toBe(1);
      ui.close();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('shows the background shells known when the Ink terminal starts', () => {
      const sessions = [
        {
          id: 'terminal-one',
          workingDirectory: '/project',
          command: 'pnpm dev',
          status: ShellSessionStatus.RUNNING,
          background: true,
          outputTail: 'ready',
          startedAt: '2026-10-07T00:00:00.000Z',
        },
      ];
      const { renderer } = inkTerminal({
        shellSessions: {
          sessions,
          onDidChange: () => () => {},
          shutdown: vi.fn(),
        } as unknown as ShellSessionManager,
      });

      expect(renderer.setBackgroundShells).toHaveBeenCalledWith(sessions);
    });
  });

  describe(TerminalUI.prototype.showHelp, () => {
    it('prints the command help', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showHelp();

      expect(output.value).toBe(`${TerminalUI.help}\n`);
    });
  });

  describe(TerminalUI.prototype.showWelcome, () => {
    it('describes the provider, project roots, log, and tracing in redirected output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showWelcome(projectContext(), '/state/trace.log', true, presentation());

      expect(output.value).toBe(
        `Glyph | Fixture\nProject: Project (workspace)\n  App: /project/app\n  Docs: /project/docs\nFixture usage\nLog: /state/trace.log\nFull provider tracing: on\n${TerminalUI.help}\n`,
      );
    });

    it('falls back to a generic greeting with logging and tracing off in redirected output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showWelcome(projectContext(), undefined, false);

      expect(output.value).toBe(
        `Glyph\nProject: Project (workspace)\n  App: /project/app\n  Docs: /project/docs\nLog: off\nFull provider tracing: off\n${TerminalUI.help}\n`,
      );
    });

    it('describes the provider, project roots, log, and tracing in Ink', () => {
      const { ui, renderer } = inkTerminal();

      ui.showWelcome(projectContext(), '/state/trace.log', true, presentation());

      const rendered = frame(renderer.append.mock.calls[0]?.[0]);
      expect(rendered).toContain('Glyph | Fixture');
      expect(rendered).toContain('Project: Project (workspace)');
      expect(rendered).toContain('  App: /project/app');
      expect(rendered).toContain('  Docs: /project/docs');
      expect(rendered).toContain('Fixture usage');
      expect(rendered).toContain('Log: /state/trace.log');
      expect(rendered).toContain('Full provider tracing: on');
    });

    it('falls back to a generic greeting with logging and tracing off in Ink', () => {
      const { ui, renderer } = inkTerminal();

      ui.showWelcome(projectContext(), undefined, false);

      const rendered = frame(renderer.append.mock.calls[0]?.[0]);
      expect(rendered).toContain('Glyph');
      expect(rendered).toContain('Log: off');
      expect(rendered).toContain('Full provider tracing: off');
      expect(rendered).not.toContain('Fixture usage');
    });
  });

  describe(TerminalUI.prototype.chooseAccount, () => {
    it('selects the only account when the answer is left empty', async () => {
      const account = chatAccount({ detail: 'Team' });
      const { ui, output } = scriptedTerminal(['']);

      await expect(ui.chooseAccount([account], presentation(), new AbortController().signal)).resolves.toEqual({
        type: AccountSelectionType.ACCOUNT,
        account,
      });
      expect(output.value).toBe(
        '\nAccounts\n1. developer@example.com [Team]\na. Add account\nAccount number [1], or a to add: ',
      );
    });

    it('chooses to add an account', async () => {
      const { ui } = scriptedTerminal([' A ']);

      await expect(ui.chooseAccount([chatAccount()], presentation(), new AbortController().signal)).resolves.toEqual({
        type: AccountSelectionType.ADD,
      });
    });

    it('asks again until a listed account number is entered', async () => {
      const first = chatAccount({ id: 'first' });
      const second = chatAccount({ id: 'second', label: 'other@example.com', connected: false });
      const { ui, output } = scriptedTerminal(['', '3', '1.0', '2']);

      await expect(ui.chooseAccount([first, second], presentation(), new AbortController().signal)).resolves.toEqual({
        type: AccountSelectionType.ACCOUNT,
        account: second,
      });
      expect(output.value).toContain('2. other@example.com (signed out)\n');
      expect(output.prompts).toEqual(Array.from({ length: 4 }, () => 'Account number, or a to add: '));
      expect(occurrences(output.value, 'Choose an account number or a to add one.')).toBe(3);
    });

    it('lists accounts in Ink and reads the choice from the Ink prompt', async () => {
      const first = chatAccount({ id: 'first', detail: 'Team' });
      const second = chatAccount({ id: 'second', label: 'other@example.com', connected: false });
      const { ui, renderer } = inkTerminal();
      renderer.prompt.mockResolvedValueOnce({ prompt: 'x', attachmentPaths: [] });
      renderer.prompt.mockResolvedValueOnce({ prompt: '2', attachmentPaths: [] });

      await expect(ui.chooseAccount([first, second], presentation(), new AbortController().signal)).resolves.toEqual({
        type: AccountSelectionType.ACCOUNT,
        account: second,
      });
      const rendered = frame(renderer.append.mock.calls[0]?.[0]);
      expect(rendered).toContain('1. developer@example.com [Team]');
      expect(rendered).toContain('2. other@example.com (signed out)');
      expect(rendered).toContain('a. Add account');
      expect(frame(renderer.append.mock.calls[1]?.[0])).toContain('Choose an account number or a to add one.');
      expect(renderer.prompt).toHaveBeenCalledWith('Account number, or a to add: ', expect.any(AbortSignal));
    });
  });

  describe(TerminalUI.prototype.chooseModel, () => {
    it('uses the configured model without asking', async () => {
      const { ui, output } = scriptedTerminal([]);

      await expect(ui.chooseModel(models(), 'model-b', new AbortController().signal)).resolves.toEqual({
        slug: 'model-b',
        name: 'Model B',
      });
      expect(output.value).toBe('1. Model A (model-a)\n2. Model B (model-b)\n');
    });

    it('warns about an unavailable configured model and asks until a listed number is entered', async () => {
      const { ui, output } = scriptedTerminal(['abc', '9', '1']);

      await expect(ui.chooseModel(models(), 'retired', new AbortController().signal)).resolves.toEqual({
        slug: 'model-a',
        name: 'Model A',
      });
      expect(output.value).toContain('CHAT_MODEL is not in this account catalog. Choose an available model.\n');
      expect(output.prompts).toEqual(['Model number: ', 'Model number: ', 'Model number: ']);
    });

    it('lists models in Ink and asks without a configured model', async () => {
      const { ui, renderer } = inkTerminal();
      renderer.prompt.mockResolvedValueOnce({ prompt: '2', attachmentPaths: [] });

      await expect(ui.chooseModel(models(), undefined, new AbortController().signal)).resolves.toEqual({
        slug: 'model-b',
        name: 'Model B',
      });
      const rendered = frame(renderer.append.mock.calls[0]?.[0]);
      expect(rendered).toContain('Available models');
      expect(rendered).toContain('2. Model B (model-b)');
      expect(renderer.append).toHaveBeenCalledOnce();
    });
  });

  describe(TerminalUI.prototype.confirmInferenceAccess, () => {
    it.each([
      { answer: ' Y ', expected: true },
      { answer: 'n', expected: false },
      { answer: '', expected: false },
    ])('treats "$answer" as consent $expected', async ({ answer, expected }) => {
      const { ui, output } = scriptedTerminal([answer]);

      await expect(ui.confirmInferenceAccess('Enable model access?', new AbortController().signal)).resolves.toBe(
        expected,
      );
      expect(output.prompts).toEqual(['Enable model access? [y/N]: ']);
    });
  });

  describe(TerminalUI.prototype.acknowledgeAccountNotice, () => {
    it('shows the notice and waits for acknowledgement', async () => {
      const { ui, output } = scriptedTerminal(['']);

      await ui.acknowledgeAccountNotice(
        { message: 'Preview terms changed.', acknowledgementPrompt: 'Press Enter: ' },
        new AbortController().signal,
      );

      expect(output.value).toBe('Preview terms changed.\nPress Enter: ');
    });
  });

  describe(TerminalUI.prototype.authorize, () => {
    it('prints the sign-in link and opens it with the macOS browser launcher', async () => {
      setPlatform('darwin');
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      await ui.authorize({ url: 'https://auth.example/login', title: 'Sign in', message: 'Continue in the browser.' });
      child.emit('error', new Error('launcher missing'));

      expect(output.value).toBe(
        '\nSign in\nContinue in the browser.\n\nIf the browser does not open, visit:\nhttps://auth.example/login\n\n',
      );
      expect(spawn).toHaveBeenLastCalledWith('open', ['https://auth.example/login'], { stdio: 'ignore' });
      expect(child.unref).toHaveBeenCalledOnce();
    });

    it('opens the sign-in link with the desktop launcher on other Unix systems', async () => {
      setPlatform('linux');
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
      const ui = new TerminalUI(new PassThrough(), new MemoryOutput(false), new MemoryOutput(false));
      onTestFinished(() => ui.close());

      await ui.authorize({ url: 'https://auth.example/login', title: 'Sign in', message: 'Continue.' });

      expect(spawn).toHaveBeenLastCalledWith('xdg-open', ['https://auth.example/login'], { stdio: 'ignore' });
    });

    it('only shows the sign-in link in Ink on Windows', async () => {
      setPlatform('win32');
      vi.mocked(spawn).mockClear();
      const { ui, renderer } = inkTerminal();

      await ui.authorize({ url: 'https://auth.example/login', title: 'Sign in', message: 'Continue.' });

      const rendered = frame(renderer.append.mock.calls[0]?.[0]);
      expect(rendered).toContain('Sign in');
      expect(rendered).toContain('If the browser does not open, visit:');
      expect(rendered).toContain('https://auth.example/login');
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe(TerminalUI.prototype.nextAction, () => {
    it('asks again after an empty prompt and reports unknown slash commands', async () => {
      const { ui, output } = scriptedTerminal(['   ', '/unknown']);

      await expect(ui.nextAction(new AbortController().signal)).resolves.toEqual({
        type: TerminalActionType.UNKNOWN_COMMAND,
      });
      expect(output.prompts).toEqual(['you> ', 'you> ']);
    });

    it('passes project files and pending change counts to the Ink prompt', async () => {
      const files = fileSearch(async (query, { generation }) => ({ generation, query, fileCount: 0, matches: [] }));
      const { ui, renderer } = inkTerminal({ files });
      renderer.prompt.mockResolvedValueOnce({ prompt: ' ', attachmentPaths: [] });
      renderer.prompt.mockResolvedValueOnce({ prompt: '/help', attachmentPaths: [] });
      const signal = new AbortController().signal;

      await expect(ui.nextAction(signal, 2)).resolves.toEqual({ type: TerminalActionType.HELP });
      expect(renderer.prompt).toHaveBeenCalledTimes(2);
      expect(renderer.prompt).toHaveBeenLastCalledWith('you> ', signal, files, 2);
    });
  });

  describe(TerminalUI.prototype.preservePromptDraft, () => {
    it('keeps the Ink prompt draft', () => {
      const { ui, renderer } = inkTerminal();

      ui.preservePromptDraft();

      expect(renderer.preservePromptDraft).toHaveBeenCalledOnce();
    });

    it('does nothing in redirected IO', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.preservePromptDraft();

      expect(output.value).toBe('');
    });
  });

  describe(TerminalUI.prototype.push, () => {
    it('writes diagnostics to the error stream and starts a fresh response section afterwards', () => {
      const output = new MemoryOutput(false);
      const errorOutput = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, errorOutput);
      onTestFinished(() => ui.close());

      ui.push({ type: ChatResponsePartType.TEXT, value: 'Before.' });
      ui.push({ type: ChatResponsePartType.DIAGNOSTIC, severity: DiagnosticSeverity.ERROR, message: 'Trace failed.' });
      ui.push({ type: ChatResponsePartType.TEXT, value: 'After.' });

      expect(output.value).toBe('assistant> Before.assistant> After.');
      expect(errorOutput.value).toBe('Trace failed.\n');
    });

    it('separates tool activity from preceding text and reports started and silent tools', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.push({ type: ChatResponsePartType.TEXT, value: 'Reading.' });
      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: { phase: ToolActivityPhase.STARTED, namespace: 'project', name: 'read', callId: 'a', arguments: '' },
      });
      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: { phase: ToolActivityPhase.COMPLETED, name: 'read', callId: 'a', arguments: '' },
      });

      expect(output.value).toBe('assistant> Reading.\n\n[project.read …]\n[read ✓]\n');
    });

    it.each([
      { name: 'a plain message', error: 'Denied.', expected: 'Error: Denied.' },
      { name: 'an empty value', error: null, expected: 'Error: null' },
      { name: 'a list', error: ['first', 2], expected: 'Error: first, 2' },
      { name: 'a message without code', error: { message: 'Only message.' }, expected: 'Error: Only message.' },
      { name: 'a code without message', error: { code: 'DENIED' }, expected: 'Error: DENIED' },
      {
        name: 'an object without a readable code or message',
        error: { code: 5, message: false },
        expected: 'Error: {"code":5,"message":false}',
      },
    ])('describes a failed tool reporting $name', ({ error, expected }) => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: {
          phase: ToolActivityPhase.COMPLETED,
          name: 'write',
          callId: 'call',
          arguments: 'line one\nline two\n',
          output: JSON.stringify({ error }),
        },
      });

      expect(output.value).toBe(`[write ×]\n  line one\n  line two\n  ${expected}\n`);
    });

    it('describes tool error details that cannot be serialized', () => {
      vi.spyOn(JSON, 'parse').mockReturnValueOnce({ error: { size: 10n, missing: undefined } });
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.push({
        type: ChatResponsePartType.TOOL,
        activity: { phase: ToolActivityPhase.COMPLETED, name: 'write', callId: 'call', arguments: '', output: '{}' },
      });

      expect(output.value).toBe(
        '[write ×]\n  Error: Unprintable error details (size=Unprintable error details; missing=undefined)\n',
      );
    });
  });

  describe(TerminalUI.prototype.showTurnCompleted, () => {
    it('prints the duration and token usage in redirected output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showTurnCompleted(1_500, usage());

      expect(output.value).toBe('\n[1.5s | input 10 (cached 2) | output 5 (reasoning 1) | total 15]\n\n');
    });

    it('completes the Ink response with the duration and token usage', () => {
      const { ui, renderer } = inkTerminal();

      ui.showTurnCompleted(2_000, usage());

      expect(frame(renderer.completeResponse.mock.calls[0]?.[0])).toBe(
        '[2.0s | input 10 (cached 2) | output 5 (reasoning 1) | total 15]',
      );
    });
  });

  describe(TerminalUI.prototype.showTurnFailed, () => {
    it('reports the failure on the error stream in redirected output', () => {
      const errorOutput = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), new MemoryOutput(false), errorOutput);
      onTestFinished(() => ui.close());

      ui.showTurnFailed('Provider failed.');

      expect(errorOutput.value).toBe('\nProvider failed.\nThis turn was not added to history.\n\n');
    });

    it('completes the Ink response with the failure', () => {
      const { ui, renderer } = inkTerminal();

      ui.showTurnFailed('Provider failed.');

      expect(frame(renderer.completeResponse.mock.calls[0]?.[0])).toBe(
        'Provider failed.\nThis turn was not added to history.',
      );
    });
  });

  describe(TerminalUI.prototype.showActive, () => {
    it('prints the active account and model in redirected output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showActive(chatAccount({ detail: 'Team' }), { slug: 'model-a', name: 'Model A' }, presentation());
      ui.showActive(chatAccount(), { slug: 'model-a', name: 'Model A' }, presentation());

      expect(output.value).toBe(
        '\nActive  developer@example.com [Team]\nModel   model-a  Fixture access\n\n' +
          '\nActive  developer@example.com\nModel   model-a  Fixture access\n\n',
      );
    });

    it('shows the active account and model in Ink', () => {
      const { ui, renderer } = inkTerminal();

      ui.showActive(chatAccount({ detail: 'Team' }), { slug: 'model-a', name: 'Model A' }, presentation());
      ui.showActive(chatAccount(), { slug: 'model-a', name: 'Model A' }, presentation());

      expect(frame(renderer.append.mock.calls[0]?.[0])).toContain('Active  developer@example.com [Team]');
      expect(frame(renderer.append.mock.calls[1]?.[0])).toContain('Active  developer@example.com\n');
      expect(frame(renderer.append.mock.calls[1]?.[0])).toContain('Model   model-a  Fixture access');
    });
  });

  describe('status messages', () => {
    it('prints conversation, command, usage, trace, logout, and error notices in redirected output', () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      ui.showConversationReset();
      ui.showUnknownCommand();
      ui.showUsage(usage());
      ui.showTrace(true, '/state/trace.log');
      ui.showTrace(true, undefined);
      ui.showTrace(false, '/state/trace.log');
      ui.showLogout(true);
      ui.showLogout(false);
      ui.showError('\u001b[31mBroken\u001b[0m');

      expect(output.value).toBe(
        [
          'Conversation cleared.',
          'Unknown command. Use /help.',
          'input 10 (cached 2) | output 5 (reasoning 1) | total 15',
          'Completed requests only. Plan/credit limits: https://chatgpt.com/settings/usage',
          'Full provider tracing is on: /state/trace.log',
          'Full provider tracing is on: logger destination unavailable',
          'Full provider tracing is off.',
          'Signed out. Renewable session revoked.',
          "Local credentials cleared. Remote revocation was not confirmed; review the provider's credential settings.",
          'Broken',
          '',
        ].join('\n'),
      );
    });

    it('shows notices in Ink', () => {
      const { ui, renderer } = inkTerminal();

      ui.showError('Broken');

      expect(frame(renderer.append.mock.calls[0]?.[0])).toBe('Broken');
    });
  });

  describe(TerminalUI.prototype.reviewProposals, () => {
    it('does nothing when no reviews are active', async () => {
      const output = new MemoryOutput(false);
      const ui = new TerminalUI(new PassThrough(), output, new MemoryOutput(false));
      onTestFinished(() => ui.close());

      await ui.reviewProposals(
        { activeReviews: [] } as unknown as ProposalReviewManager,
        new AbortController().signal,
        () => {},
      );

      expect(output.value).toBe('');
    });

    it('hands active reviews to the Ink reviewer', async () => {
      const fixture = createProposalReviewFixture();
      const { ui, renderer } = inkTerminal();
      const signal = new AbortController().signal;
      const interrupt = vi.fn();

      await ui.reviewProposals(fixture.manager, signal, interrupt);

      expect(renderer.review).toHaveBeenCalledWith(fixture.manager, signal, interrupt);
    });

    it('asks again after an unrecognized answer and keeps the change when confirmed', async () => {
      const fixture = createProposalReviewFixture();
      const { ui, output } = scriptedTerminal(['maybe', 'Y']);

      await ui.reviewProposals(fixture.manager, new AbortController().signal, () => {});

      expect(output.prompts).toEqual(['Keep / revert? [y/n/q]: ', 'Keep / revert? [y/n/q]: ']);
      expect(output.value).toContain('src/App.tsx');
      expect(fixture.accept).toHaveBeenCalledWith('proposal', 'item');
      expect(fixture.reject).not.toHaveBeenCalled();
    });

    it('reverts a change', async () => {
      const fixture = createProposalReviewFixture();
      const { ui } = scriptedTerminal(['n']);

      await ui.reviewProposals(fixture.manager, new AbortController().signal, () => {});

      expect(fixture.reject).toHaveBeenCalledWith('proposal', 'item');
    });

    it('stops reviewing when asked to quit', async () => {
      const fixture = createProposalReviewFixture();
      const { ui } = scriptedTerminal(['q']);

      await ui.reviewProposals(fixture.manager, new AbortController().signal, () => {});

      expect(fixture.accept).not.toHaveBeenCalled();
      expect(fixture.reject).not.toHaveBeenCalled();
    });

    it('reports failed decisions and keeps the change pending', async () => {
      const fixture = createProposalReviewFixture();
      const accept = fixture.accept.getMockImplementation();
      fixture.accept
        .mockRejectedValueOnce(new Error('File changed\u0007'))
        .mockRejectedValueOnce('locked')
        .mockImplementationOnce(async (...values) => accept?.(...values));
      const { ui, errorOutput } = scriptedTerminal(['y', 'y', 'y']);

      await ui.reviewProposals(fixture.manager, new AbortController().signal, () => {});

      expect(errorOutput.value).toBe('Error: File changed\nError: locked\n');
      expect(fixture.accept).toHaveBeenCalledTimes(3);
    });

    it('retries saving a pending checkpoint before continuing the review', async () => {
      const fixture = createProposalReviewFixture();
      const checkpoints = [true, true, true];
      const flushPendingCheckpoint = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error('save failed'))
        .mockRejectedValueOnce('disk offline');
      const manager = {
        activeReviews: fixture.manager.activeReviews,
        get hasPendingCheckpoint() {
          return checkpoints.shift() ?? false;
        },
        flushPendingCheckpoint,
        acceptInReview: fixture.accept,
        rejectInReview: fixture.reject,
      } as unknown as ProposalReviewManager;
      const { ui, output, errorOutput } = scriptedTerminal(['r', ' R ', 'q']);

      await ui.reviewProposals(manager, new AbortController().signal, () => {});

      expect(flushPendingCheckpoint).toHaveBeenCalledTimes(3);
      expect(errorOutput.value).toBe('Error: save failed\nError: disk offline\n');
      expect(output.prompts).toEqual([
        'Retry saving review? [r/q]: ',
        'Retry saving review? [r/q]: ',
        'Keep / revert? [y/n/q]: ',
      ]);
    });

    it('stops reviewing when a failed checkpoint is not retried', async () => {
      const fixture = createProposalReviewFixture();
      const flushPendingCheckpoint = vi.fn(async () => {
        throw new Error('save failed');
      });
      const manager = {
        activeReviews: fixture.manager.activeReviews,
        hasPendingCheckpoint: true,
        flushPendingCheckpoint,
      } as unknown as ProposalReviewManager;
      const { ui } = scriptedTerminal(['q']);

      await ui.reviewProposals(manager, new AbortController().signal, () => {});

      expect(flushPendingCheckpoint).toHaveBeenCalledOnce();
    });
  });

  describe(TerminalUI.prototype.present, () => {
    it('asks untitled questions through redirected IO', async () => {
      const { ui, output } = scriptedTerminal(['2']);

      await expect(
        ui.present({ questions: [question('single', false)] }, new AbortController().signal),
      ).resolves.toEqual({ answers: [{ questionId: 'single', type: 'SELECTION', optionIds: ['second'] }] });
      expect(output.value.startsWith('\nChoose for single.\n')).toBe(true);
    });

    it('forwards an interrupt raised by the Ink question form', async () => {
      const { ui, renderer } = inkTerminal();
      renderer.presentQuestionForm.mockImplementationOnce(async (_form, _signal, interrupt) => {
        interrupt();
        return { answers: [] };
      });
      const listener = vi.fn();
      ui.on('SIGINT', listener);

      await expect(
        ui.present({ questions: [question('single', false)] }, new AbortController().signal),
      ).resolves.toEqual({ answers: [] });
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe(TerminalUI.prototype.presentShellPermission, () => {
    it.each([
      { choice: '1', decision: ShellPermissionDecision.ALLOW_ONCE },
      { choice: '2', decision: ShellPermissionDecision.ALWAYS_ALLOW },
      { choice: '3', decision: ShellPermissionDecision.ALLOW_SAFE },
      { choice: '4', decision: ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE },
      { choice: '6', decision: ShellPermissionDecision.DENY },
    ])('returns $decision for choice $choice', async ({ choice, decision }) => {
      const { ui } = scriptedTerminal([choice]);

      await expect(
        ui.presentShellPermission({ command: 'pnpm test', workingDirectory: '/project' }, new AbortController().signal),
      ).resolves.toBe(decision);
    });

    it('forwards an interrupt raised by the Ink permission prompt', async () => {
      const { ui, renderer } = inkTerminal();
      renderer.presentShellPermission.mockImplementationOnce(async (_request, _signal, interrupt) => {
        interrupt();
        return ShellPermissionDecision.DENY;
      });
      const listener = vi.fn();
      ui.on('SIGINT', listener);

      await expect(
        ui.presentShellPermission({ command: 'pnpm test', workingDirectory: '/project' }, new AbortController().signal),
      ).resolves.toBe(ShellPermissionDecision.DENY);
      expect(listener).toHaveBeenCalledOnce();
    });
  });
});

function inkTerminal(
  options: { output?: TerminalOutputStream; files?: WorkspacePathIndex; shellSessions?: ShellSessionManager } = {},
) {
  const renderer = {
    append: vi.spyOn(TerminalInkRenderer.prototype, 'append').mockImplementation(() => {}),
    replaceTranscript: vi.spyOn(TerminalInkRenderer.prototype, 'replaceTranscript').mockImplementation(() => {}),
    completeResponse: vi.spyOn(TerminalInkRenderer.prototype, 'completeResponse').mockImplementation(() => {}),
    prompt: vi.spyOn(TerminalInkRenderer.prototype, 'prompt'),
    review: vi.spyOn(TerminalInkRenderer.prototype, 'review').mockResolvedValue(undefined),
    presentQuestionForm: vi.spyOn(TerminalInkRenderer.prototype, 'presentQuestionForm'),
    presentShellPermission: vi.spyOn(TerminalInkRenderer.prototype, 'presentShellPermission'),
    preservePromptDraft: vi.spyOn(TerminalInkRenderer.prototype, 'preservePromptDraft'),
    setBackgroundShells: vi.spyOn(TerminalInkRenderer.prototype, 'setBackgroundShells'),
  };
  const terminal = new VirtualTTY();
  const ui = new TerminalUI(
    terminal,
    options.output ?? new MemoryOutput(true),
    new MemoryOutput(false),
    options.files,
    options.shellSessions,
  );
  onTestFinished(() => {
    ui.close();
    vi.restoreAllMocks();
  });
  return { ui, terminal, renderer };
}

function scriptedTerminal(answers: readonly string[]) {
  const input = new PassThrough();
  const output = new ScriptedOutput(input, answers);
  const errorOutput = new MemoryOutput(false);
  const ui = new TerminalUI(input, output, errorOutput);
  onTestFinished(() => ui.close());
  return { ui, output, errorOutput };
}

function frame(node: unknown): string {
  const view = render(node as ReactElement);
  const text = stripVTControlCharacters(view.lastFrame() ?? '');
  view.unmount();
  return text;
}

function setPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
}

function chatAccount(overrides: Partial<ChatAccount> = {}): ChatAccount {
  return {
    provider: 'fixture',
    id: 'account',
    label: 'developer@example.com',
    connected: true,
    inferenceAccess: true,
    ...overrides,
  };
}

function presentation(): ChatBackendPresentation {
  return {
    name: 'Fixture',
    welcome: 'Glyph | Fixture',
    usageDescription: 'Fixture usage',
    accountsHeading: 'Accounts',
    addAccountLabel: 'Add account',
    activeAccessLabel: 'Fixture access',
  };
}

function projectContext(): ProjectContext {
  return {
    id: 'project',
    mutationIdentity: 'project-root',
    kind: ProjectContextKind.WORKSPACE,
    name: 'Project',
    authority: 'local',
    roots: [
      { name: 'App', path: '/project/app' },
      { name: 'Docs', path: '/project/docs' },
    ],
  };
}

function models(): Model[] {
  return [
    { slug: 'model-a', name: 'Model A' },
    { slug: 'model-b', name: 'Model B' },
  ];
}

function usage(): Usage {
  return { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: 1, totalTokens: 15 };
}

function chatSummary(id: string, title: string, turnCount: number) {
  return {
    schemaVersion: 3 as const,
    id,
    title,
    titleOrigin: 'generated' as const,
    projectContextId: 'project-context',
    accountProvider: 'fixture',
    accountId: 'account',
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

class ScriptedOutput extends MemoryOutput {
  readonly prompts: string[] = [];
  private readonly answers: string[];

  constructor(
    private readonly input: PassThrough,
    answers: readonly string[],
  ) {
    super(false);
    this.answers = [...answers];
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = String(chunk);
    if (!text.endsWith('\n')) {
      this.prompts.push(text);
      const answer = this.answers.shift();
      if (answer !== undefined) setImmediate(() => this.input.write(`${answer}\n`));
    }
    super._write(chunk, encoding, callback);
  }
}

class ColumnlessOutput extends Writable {
  readonly isTTY = true;

  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
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
