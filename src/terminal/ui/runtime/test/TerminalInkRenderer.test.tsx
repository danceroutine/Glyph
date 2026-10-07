import { Duplex, Writable } from 'node:stream';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.ts';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.ts';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.ts';
import type { ActivePromptRequest } from '../../prompt/PromptRequest.ts';
import type { ProposalReviewRequest } from '../../proposal/ProposalReviewRequest.ts';
import type { QuestionFormRequest } from '../../question/QuestionFormRequest.ts';
import type { TerminalShellPermissionRequest } from '../../shell-permission/ShellPermissionRequest.ts';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.ts';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.ts';
import type { TranscriptEntry } from '../../shell/TranscriptEntry.ts';
import { TerminalInkRenderer } from '../TerminalInkRenderer.tsx';
import { createProposalReviewFixture } from '../../proposal/test/ProposalReviewFixture.ts';

describe(TerminalInkRenderer, () => {
  describe('lifecycle', () => {
    it('renders transcript and response content, prompts, and restores the terminal on close', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      renderer.append(<Text>history</Text>);
      renderer.beginResponse();
      renderer.pushResponse({ type: ChatResponsePartType.TEXT, value: 'answer' });
      renderer.completeResponse(<Text>footer</Text>);
      const prompt = renderer.prompt('you> ', new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('hello');
      await tick();
      terminal.push('\r');

      await expect(prompt).resolves.toEqual({ prompt: 'hello', attachmentPaths: [] });
      await waitUntil(() => output.value.includes('history') && output.value.includes('answer'));
      expect(output.value).toContain('history');
      expect(output.value).toContain('answer');
      renderer.close();
      renderer.close();
      expect(terminal.rawTransitions.at(-1)).toBe(false);
    });

    it('replaces the visible transcript when a different chat is activated', async () => {
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(new TestTerminal(), output, output);
      const replacement = <Text>new chat</Text>;
      renderer.append(<Text>old chat</Text>);

      renderer.replaceTranscript(replacement);

      await waitUntil(() => output.value.includes('new chat'));
      expect(rendererValue<readonly TranscriptEntry[]>(renderer, 'entries')).toEqual([
        expect.objectContaining({ content: replacement }),
      ]);
      renderer.close();
    });

    it('keeps a draft composer mounted during a response and submits its text afterward', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      const files = {} as WorkspacePathIndex;
      const firstPrompt = renderer.prompt('you> ', new AbortController().signal, files);

      await waitUntil(() => terminal.isRaw);
      terminal.push('first message');
      await tick();
      terminal.push('\r');
      await expect(firstPrompt).resolves.toEqual({ prompt: 'first message', attachmentPaths: [] });

      renderer.beginResponse();
      await waitUntil(() => output.value.includes('Agent responding · draft only'));
      terminal.push('follow-up draft');
      await waitUntil(() => output.value.includes('follow-up draft'));
      terminal.push('\r');
      await tick();

      expect(output.value).toContain('follow-up draft');
      expect(rendererRequest(renderer, 'promptRequest')).toMatchObject({ acceptsSubmission: false, files });

      renderer.completeResponse(<Text>done</Text>);
      const secondPrompt = renderer.prompt('you> ', new AbortController().signal);
      terminal.push('\r');

      await expect(secondPrompt).resolves.toEqual({ prompt: 'follow-up draft', attachmentPaths: [] });
      renderer.close();
    });

    it('preserves an active prompt draft when its wait is interrupted for autonomous work', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const controller = new AbortController();
      const firstPrompt = renderer.prompt('you> ', controller.signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('keep this draft');
      await tick();
      renderer.preservePromptDraft();
      renderer.preservePromptDraft();
      controller.abort(new Error('wake'));
      await expect(firstPrompt).rejects.toThrow('wake');

      renderer.beginResponse();
      renderer.completeResponse(<Text>autonomous turn done</Text>);
      const resumed = renderer.prompt('you> ', new AbortController().signal);
      terminal.push('\r');

      await expect(resumed).resolves.toEqual({ prompt: 'keep this draft', attachmentPaths: [] });
      renderer.close();
    });

    it('preserves the file-search context with an interrupted draft', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const controller = new AbortController();
      const files = {} as WorkspacePathIndex;
      const prompt = renderer.prompt('you> ', controller.signal, files);

      renderer.preservePromptDraft();
      controller.abort(new Error('wake'));

      await expect(prompt).rejects.toThrow('wake');
      expect(rendererRequest<ActivePromptRequest>(renderer, 'promptRequest').files).toBe(files);
      renderer.close();
    });

    it('does not replace an active prompt or review when a response begins', async () => {
      const promptRenderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const prompt = promptRenderer.prompt('you> ', new AbortController().signal);
      const activePrompt = rendererRequest(promptRenderer, 'promptRequest');

      promptRenderer.beginResponse();

      expect(rendererRequest(promptRenderer, 'promptRequest')).toBe(activePrompt);
      promptRenderer.close();
      await expect(prompt).rejects.toThrow('Session closed.');

      const reviewRenderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const review = reviewRenderer.review(
        createProposalReviewFixture().manager,
        new AbortController().signal,
        vi.fn(),
      );
      const activeReview = rendererRequest(reviewRenderer, 'reviewRequest');

      reviewRenderer.beginResponse();

      expect(rendererRequest(reviewRenderer, 'reviewRequest')).toBe(activeReview);
      reviewRenderer.close();
      await expect(review).rejects.toThrow('Session closed.');
    });

    it('places the cursor on the prompt row below its top margin', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);

      const prompt = renderer.prompt('you> ', new AbortController().signal);
      await waitUntil(() => output.value.includes('\u001B[7G\u001B[?25h'));

      expect(output.value).not.toContain('\u001B[1A\u001B[7G\u001B[?25h');
      renderer.close();
      await expect(prompt).rejects.toThrow('Session closed.');
    });

    it('waits for the bottom rail measurement before placing the cursor after a chat switch', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      const command = renderer.prompt('you> ', new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('/chat saved');
      await tick();
      terminal.push('\r');
      await command;
      const outputOffset = output.value.length;

      renderer.replaceTranscript(<Text>Chat saved</Text>);
      const nextPrompt = renderer.prompt('you> ', new AbortController().signal);
      await waitUntil(() => output.value.slice(outputOffset).includes('\u001B[7G\u001B[?25h'));

      const switchedOutput = output.value.slice(outputOffset);
      expect(switchedOutput).not.toMatch(/\u001b\[\d+A\u001b\[7G\u001b\[\?25h/u);
      renderer.close();
      await expect(nextPrompt).rejects.toThrow('Session closed.');
    });

    it('renders a pending-review eyebrow and positions the cursor beneath it', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);

      const prompt = renderer.prompt('you> ', new AbortController().signal, undefined, 3);
      await waitUntil(() => output.value.includes('3 pending changes'));
      await waitUntil(() => output.value.includes('\u001B[7G\u001B[?25h'));

      expect(output.value).toContain('/review');
      expect(output.value).toContain('to resume');
      renderer.close();
      await expect(prompt).rejects.toThrow('Session closed.');
    });

    it('supports responses completed without streamed parts', () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());

      renderer.completeResponse(<Text>footer</Text>);
      renderer.close();
    });

    it('uses the default terminal width when output columns are unavailable', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      Object.defineProperty(output, 'columns', { value: undefined });
      const renderer = new TerminalInkRenderer(terminal, output, output);
      const prompt = renderer.prompt('you> ', new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('hello');
      await tick();
      terminal.push('\r');

      await expect(prompt).resolves.toMatchObject({ prompt: 'hello' });
      renderer.close();
    });

    it('forwards and removes interrupt listeners', () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const listener = vi.fn();
      renderer.on('SIGINT', listener);

      renderer.requestInterrupt();
      renderer.off('SIGINT', listener);
      renderer.requestInterrupt();

      expect(listener).toHaveBeenCalledOnce();
      renderer.close();
    });

    it('routes prompt interrupts through the renderer snapshot', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const listener = vi.fn();
      renderer.on('SIGINT', listener);
      const prompt = renderer.prompt('you> ', new AbortController().signal);

      await waitUntil(() => terminal.isRaw);
      terminal.push('\x03');
      await waitUntil(() => listener.mock.calls.length === 1);
      renderer.close();

      await expect(prompt).rejects.toThrow('Session closed.');
    });

    it('forwards input closure', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const listener = vi.fn();
      renderer.on('close', listener);

      terminal.emit('end');
      await waitUntil(() => listener.mock.calls.length === 1);

      renderer.close();
    });

    it('rejects prompts aborted with and without an explicit reason', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const explicit = new AbortController();
      const explicitPrompt = renderer.prompt('you> ', explicit.signal);
      explicit.abort(new Error('stop'));
      await expect(explicitPrompt).rejects.toThrow('stop');

      const implicit = new AbortController();
      Object.defineProperty(implicit.signal, 'reason', { value: undefined });
      const implicitPrompt = renderer.prompt('you> ', implicit.signal);
      implicit.abort();
      await expect(implicitPrompt).rejects.toThrow('Input cancelled.');

      renderer.close();
    });

    it('ignores late prompt completion and abort callbacks', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const signal = new TestAbortSignal();
      const prompt = renderer.prompt('you> ', signal.value);
      const request = rendererRequest<ActivePromptRequest>(renderer, 'promptRequest');

      await waitUntil(() => terminal.isRaw);
      terminal.push('done');
      await tick();
      terminal.push('\r');
      await expect(prompt).resolves.toMatchObject({ prompt: 'done' });
      request.complete({ prompt: 'late', attachmentPaths: [] });
      signal.abort(new Error('late'));

      renderer.close();
    });

    it('rejects unavailable and pre-aborted prompts', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const first = renderer.prompt('you> ', new AbortController().signal);

      await expect(renderer.prompt('you> ', new AbortController().signal)).rejects.toThrow(
        'The terminal is already waiting for input.',
      );
      renderer.close();
      await expect(renderer.prompt('you> ', AbortSignal.abort())).rejects.toThrow('Session closed.');
      await expect(first).rejects.toThrow();

      const available = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      await expect(available.prompt('you> ', AbortSignal.abort(new Error('already aborted')))).rejects.toThrow(
        'already aborted',
      );
      available.close();
    });

    it('does not refresh after closure', () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      renderer.close();

      renderer.append(<Text>ignored</Text>);
    });
  });

  describe(TerminalInkRenderer.prototype.review, () => {
    it('returns immediately when there are no reviews', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const manager = { activeReviews: [] } as unknown as ProposalReviewManager;

      await expect(renderer.review(manager, new AbortController().signal, vi.fn())).resolves.toBeUndefined();
      renderer.close();
    });

    it('completes a deferred review from keyboard input', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const fixture = createProposalReviewFixture();
      renderer.beginResponse();
      await tick();
      terminal.push('draft through review');
      await tick();
      const review = renderer.review(fixture.manager, new AbortController().signal, vi.fn());

      await waitUntil(() => terminal.isRaw);
      terminal.push('q');

      await expect(review).resolves.toBeUndefined();
      const prompt = renderer.prompt('you> ', new AbortController().signal);
      terminal.push('\r');
      await expect(prompt).resolves.toEqual({ prompt: 'draft through review', attachmentPaths: [] });
      renderer.close();
    });

    it('commits a review completion receipt to the transcript', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      const fixture = createProposalReviewFixture();
      const review = renderer.review(fixture.manager, new AbortController().signal, vi.fn());

      await waitUntil(() => terminal.isRaw);
      terminal.push('y');
      await review;
      await waitUntil(() => output.value.includes('1 accepted'));

      expect(output.value).toContain('Review complete');
      expect(output.value).toContain('1 accepted');
      expect(output.value).toContain('0 rejected');
      renderer.close();
    });

    it('rejects reviews aborted with and without an explicit reason', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const explicitFixture = createProposalReviewFixture();
      const explicit = new AbortController();
      const explicitReview = renderer.review(explicitFixture.manager, explicit.signal, vi.fn());
      explicit.abort(new Error('stop'));
      await expect(explicitReview).rejects.toThrow('stop');

      const implicitFixture = createProposalReviewFixture();
      const implicit = new AbortController();
      Object.defineProperty(implicit.signal, 'reason', { value: undefined });
      const implicitReview = renderer.review(implicitFixture.manager, implicit.signal, vi.fn());
      implicit.abort();
      await expect(implicitReview).rejects.toThrow('Review cancelled.');

      renderer.close();
    });

    it('ignores late review completion and abort callbacks', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const fixture = createProposalReviewFixture();
      const signal = new TestAbortSignal();
      const review = renderer.review(fixture.manager, signal.value, vi.fn());
      const request = rendererRequest<ProposalReviewRequest>(renderer, 'reviewRequest');

      await waitUntil(() => terminal.isRaw);
      terminal.push('q');
      await expect(review).resolves.toBeUndefined();
      request.complete();
      signal.abort(new Error('late'));

      renderer.close();
    });
  });

  describe(TerminalInkRenderer.prototype.presentQuestionForm, () => {
    it('answers during a response, records a receipt, and preserves the draft composer', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      renderer.beginResponse();
      await tick();
      terminal.push('draft message');
      await tick();

      const question = renderer.presentQuestionForm(questionForm(), new AbortController().signal, vi.fn());
      await waitUntil(() => output.value.includes('Choose a color'));
      terminal.push('\r');

      await expect(question).resolves.toEqual({
        answers: [{ questionId: 'color', type: 'SELECTION', optionIds: ['red'] }],
      });
      await waitUntil(() => output.value.includes('Red'));
      const prompt = renderer.prompt('you> ', new AbortController().signal);
      terminal.push('\r');
      await expect(prompt).resolves.toEqual({ prompt: 'draft message', attachmentPaths: [] });
      renderer.close();
    });

    it('rejects questions aborted with and without an explicit reason', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const explicit = new AbortController();
      const explicitQuestion = renderer.presentQuestionForm(questionForm(), explicit.signal, vi.fn());
      explicit.abort(new Error('stop'));
      await expect(explicitQuestion).rejects.toThrow('stop');

      const implicit = new AbortController();
      Object.defineProperty(implicit.signal, 'reason', { value: undefined });
      const implicitQuestion = renderer.presentQuestionForm(questionForm(), implicit.signal, vi.fn());
      implicit.abort();
      await expect(implicitQuestion).rejects.toThrow('Question cancelled.');
      renderer.close();
    });

    it('ignores late completion and abort callbacks', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const signal = new TestAbortSignal();
      const question = renderer.presentQuestionForm(questionForm(), signal.value, vi.fn());
      const request = rendererRequest<QuestionFormRequest>(renderer, 'questionRequest');

      await waitUntil(() => terminal.isRaw);
      terminal.push('\r');
      await expect(question).resolves.toBeDefined();
      request.complete({ answers: [] });
      signal.abort(new Error('late'));
      renderer.close();
    });

    it('rejects unavailable, pre-aborted, and closed question interactions', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const question = renderer.presentQuestionForm(questionForm(), new AbortController().signal, vi.fn());

      await expect(renderer.presentQuestionForm(questionForm(), new AbortController().signal, vi.fn())).rejects.toThrow(
        'already waiting',
      );
      renderer.beginResponse();
      expect(rendererRequest(renderer, 'questionRequest')).toBeDefined();
      renderer.close();
      await expect(question).rejects.toThrow('Session closed.');
      await expect(renderer.presentQuestionForm(questionForm(), new AbortController().signal, vi.fn())).rejects.toThrow(
        'Session closed.',
      );

      const available = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      await expect(
        available.presentQuestionForm(questionForm(), AbortSignal.abort(new Error('already aborted')), vi.fn()),
      ).rejects.toThrow('already aborted');
      available.close();
    });
  });

  describe(TerminalInkRenderer.prototype.presentShellPermission, () => {
    it('authorizes during a response, preserves the draft, and shows background shells', async () => {
      const terminal = new TestTerminal();
      const output = new TestOutput();
      const renderer = new TerminalInkRenderer(terminal, output, output);
      renderer.beginResponse();
      await tick();
      terminal.push('draft message');
      await tick();
      renderer.setBackgroundShells([
        {
          id: 'terminal-one',
          workingDirectory: '/project',
          command: 'pnpm dev',
          status: ShellSessionStatus.RUNNING,
          background: true,
          outputTail: 'ready',
          startedAt: '2026-10-07T00:00:00.000Z',
        },
      ]);

      const permission = renderer.presentShellPermission(
        { command: 'pnpm test', workingDirectory: '/project' },
        new AbortController().signal,
        vi.fn(),
      );
      await waitUntil(() => output.value.includes('Shell permission required'));
      expect(output.value).toContain('Background terminals');
      renderer.beginResponse();
      terminal.push('2');

      await expect(permission).resolves.toBe(ShellPermissionDecision.ALWAYS_ALLOW);
      const prompt = renderer.prompt('you> ', new AbortController().signal);
      terminal.push('\r');
      await expect(prompt).resolves.toEqual({ prompt: 'draft message', attachmentPaths: [] });
      renderer.close();
    });

    it('rejects permission requests aborted with and without an explicit reason', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const explicit = new AbortController();
      const explicitPermission = renderer.presentShellPermission(shellPermission(), explicit.signal, vi.fn());
      explicit.abort(new Error('stop'));
      await expect(explicitPermission).rejects.toThrow('stop');

      const implicit = new AbortController();
      Object.defineProperty(implicit.signal, 'reason', { value: undefined });
      const implicitPermission = renderer.presentShellPermission(shellPermission(), implicit.signal, vi.fn());
      implicit.abort();
      await expect(implicitPermission).rejects.toThrow('Shell permission cancelled.');
      renderer.close();
    });

    it('ignores late completion and abort callbacks', async () => {
      const terminal = new TestTerminal();
      const renderer = new TerminalInkRenderer(terminal, new TestOutput(), new TestOutput());
      const signal = new TestAbortSignal();
      const permission = renderer.presentShellPermission(shellPermission(), signal.value, vi.fn());
      const request = rendererRequest<TerminalShellPermissionRequest>(renderer, 'shellPermissionRequest');

      await waitUntil(() => terminal.isRaw);
      terminal.push('1');
      await expect(permission).resolves.toBe(ShellPermissionDecision.ALLOW_ONCE);
      request.complete(ShellPermissionDecision.DENY);
      signal.abort(new Error('late'));
      renderer.close();
    });

    it('rejects unavailable, pre-aborted, and closed permission interactions', async () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      const permission = renderer.presentShellPermission(shellPermission(), new AbortController().signal, vi.fn());

      await expect(
        renderer.presentShellPermission(shellPermission(), new AbortController().signal, vi.fn()),
      ).rejects.toThrow('already waiting');
      renderer.close();
      await expect(permission).rejects.toThrow('Session closed.');
      await expect(
        renderer.presentShellPermission(shellPermission(), new AbortController().signal, vi.fn()),
      ).rejects.toThrow('Session closed.');

      const available = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());
      await expect(
        available.presentShellPermission(shellPermission(), AbortSignal.abort(new Error('already aborted')), vi.fn()),
      ).rejects.toThrow('already aborted');
      available.close();
    });
  });
});

function rendererRequest<Request>(
  renderer: TerminalInkRenderer,
  key: 'promptRequest' | 'questionRequest' | 'shellPermissionRequest' | 'reviewRequest',
): Request {
  return rendererValue(renderer, key);
}

function rendererValue<Value>(renderer: TerminalInkRenderer, key: string): Value {
  return (renderer as unknown as Record<string, Value>)[key]!;
}

class TestAbortSignal {
  private lastListener: (() => void) | undefined;
  readonly value = {
    aborted: false,
    reason: undefined,
    throwIfAborted: (): void => {},
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
      const callback =
        typeof listener === 'function'
          ? () => listener(new Event('abort'))
          : () => listener.handleEvent(new Event('abort'));
      this.lastListener = callback;
    },
    removeEventListener: (): void => {},
  } as unknown as AbortSignal;

  abort(reason: unknown): void {
    Object.defineProperty(this.value, 'reason', { value: reason, configurable: true });
    this.lastListener?.();
  }
}

class TestTerminal extends Duplex {
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

class TestOutput extends Writable {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  value = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += String(chunk);
    callback();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not reached.');
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function questionForm() {
  return {
    title: 'Preferences',
    questions: [
      {
        id: 'color',
        prompt: 'Choose a color.',
        options: [
          { id: 'red', label: 'Red' },
          { id: 'blue', label: 'Blue' },
        ],
        allowMultiple: false,
      },
    ],
  };
}

function shellPermission() {
  return { command: 'pnpm test', workingDirectory: '/project' };
}
