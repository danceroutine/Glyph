import { Duplex, Writable } from 'node:stream';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import type { ProposalReviewManager } from '../../../editing/reviews/ProposalReviewManager.ts';
import type { PromptRequest } from '../PromptRequest.ts';
import type { ProposalReviewRequest } from '../ProposalReviewRequest.ts';
import { TerminalInkRenderer } from '../TerminalInkRenderer.tsx';
import { createProposalReviewFixture } from './ProposalReviewFixture.ts';

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
      expect(output.value).toContain('history');
      expect(output.value).toContain('assistant> answer');
      renderer.close();
      renderer.close();
      expect(terminal.rawTransitions.at(-1)).toBe(false);
    });

    it('supports responses completed without streamed parts', () => {
      const renderer = new TerminalInkRenderer(new TestTerminal(), new TestOutput(), new TestOutput());

      renderer.completeResponse(<Text>footer</Text>);
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
      const request = rendererRequest<PromptRequest>(renderer, 'promptRequest');

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
      const review = renderer.review(fixture.manager, new AbortController().signal, vi.fn());

      await waitUntil(() => terminal.isRaw);
      terminal.push('q');

      await expect(review).resolves.toBeUndefined();
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
});

function rendererRequest<Request>(renderer: TerminalInkRenderer, key: 'promptRequest' | 'reviewRequest'): Request {
  return (renderer as unknown as Record<string, Request>)[key]!;
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
    await tick();
  }
  throw new Error('Condition was not reached.');
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
