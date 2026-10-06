import { EventEmitter } from 'node:events';
import type { ReactNode } from 'react';
import { render } from 'ink';
import type { Instance } from 'ink';
import type { ChatResponsePart } from '../../chat/ChatResponsePart.ts';
import type { WorkspaceFileSearch } from '../../context/search/WorkspaceFileSearch.ts';
import type { ProposalReviewManager } from '../../editing/reviews/ProposalReviewManager.ts';
import type { UserPromptDraft } from '../UserPromptDraft.ts';
import { Deferred } from './Deferred.ts';
import { PromptRecordPresentational } from './PromptRecord.presentational.tsx';
import type { PromptRequest } from './PromptRequest.ts';
import type { ProposalReviewRequest } from './ProposalReviewRequest.ts';
import type { TerminalInputStream } from './TerminalInputStream.ts';
import type { TerminalOutputStream } from './TerminalOutputStream.ts';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import { TerminalRootWired } from './TerminalRoot.wired.tsx';
import type { TranscriptEntry } from './TranscriptEntry.ts';
import { ResponseWired } from './Response.wired.tsx';

/**
 * Owns the single interactive Ink tree for the terminal host. All prompt,
 * streaming-response, and review rendering passes through this object so raw
 * input and redraw behavior have exactly one owner.
 */
export class TerminalInkRenderer {
  private readonly events = new EventEmitter();
  private readonly instance: Instance;
  private readonly entries: TranscriptEntry[] = [];
  private responseParts: ChatResponsePart[] | undefined;
  private promptRequest: PromptRequest | undefined;
  private reviewRequest: ProposalReviewRequest | undefined;
  private nextId = 1;
  private closed = false;

  private readonly handleInputClosed = (): void => {
    this.events.emit('close');
  };

  constructor(
    private readonly input: TerminalInputStream,
    private readonly output: TerminalOutputStream,
    private readonly errorOutput: NodeJS.WritableStream,
  ) {
    this.instance = render(<TerminalRootWired snapshot={this.snapshot()} />, {
      stdin: input,
      stdout: output,
      stderr: errorOutput,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      incrementalRendering: true,
      maxFps: 30,
    });
    input.once('end', this.handleInputClosed);
    input.once('close', this.handleInputClosed);
  }

  on(event: 'SIGINT' | 'close', listener: () => void): void {
    this.events.on(event, listener);
  }

  off(event: 'SIGINT' | 'close', listener: () => void): void {
    this.events.off(event, listener);
  }

  append(content: ReactNode): void {
    this.entries.push({ id: this.nextId++, content });
    this.refresh();
  }

  beginResponse(): void {
    this.responseParts = [];
    this.refresh();
  }

  pushResponse(part: ChatResponsePart): void {
    this.responseParts ??= [];
    this.responseParts.push(part);
    this.refresh();
  }

  completeResponse(footer: ReactNode): void {
    const parts = this.responseParts ?? [];
    this.responseParts = undefined;
    this.entries.push({
      id: this.nextId++,
      content: <ResponseWired parts={parts} footer={footer} />,
    });
    this.refresh();
  }

  async prompt(label: string, signal: AbortSignal, files?: WorkspaceFileSearch): Promise<UserPromptDraft> {
    this.assertAvailable();
    signal.throwIfAborted();
    const result = new Deferred<UserPromptDraft>();
    const id = this.nextId++;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      if (this.promptRequest?.id !== id) return;
      this.promptRequest = undefined;
      cleanup();
      this.refresh();
      result.reject(signal.reason ?? new Error('Input cancelled.'));
    };
    this.promptRequest = {
      id,
      label,
      ...(files ? { files } : {}),
      complete: draft => {
        if (this.promptRequest?.id !== id) return;
        this.promptRequest = undefined;
        cleanup();
        this.entries.push({ id, content: <PromptRecordPresentational label={label} draft={draft} /> });
        this.refresh();
        result.resolve(draft);
      },
    };
    signal.addEventListener('abort', abort, { once: true });
    this.refresh();
    return result.promise;
  }

  async review(manager: ProposalReviewManager, signal: AbortSignal, interrupt: () => void): Promise<void> {
    if (manager.activeReviews.length === 0) return;
    this.assertAvailable();
    signal.throwIfAborted();
    const result = new Deferred<void>();
    const id = this.nextId++;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const complete = (): void => {
      if (this.reviewRequest?.id !== id) return;
      this.reviewRequest = undefined;
      cleanup();
      this.refresh();
      result.resolve();
    };
    const abort = (): void => {
      if (this.reviewRequest?.id !== id) return;
      this.reviewRequest = undefined;
      cleanup();
      this.refresh();
      result.reject(signal.reason ?? new Error('Review cancelled.'));
    };
    this.reviewRequest = { id, manager, complete, interrupt };
    signal.addEventListener('abort', abort, { once: true });
    this.refresh();
    return result.promise;
  }

  requestInterrupt(): void {
    this.events.emit('SIGINT');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('end', this.handleInputClosed);
    this.input.off('close', this.handleInputClosed);
    this.instance.cleanup();
  }

  private assertAvailable(): void {
    if (this.closed) throw new Error('Session closed.');
    if (this.promptRequest || this.reviewRequest) throw new Error('The terminal is already waiting for input.');
  }

  private refresh(): void {
    if (this.closed) return;
    this.instance.rerender(<TerminalRootWired snapshot={this.snapshot()} />);
  }

  private snapshot(): TerminalRendererSnapshot {
    return {
      entries: [...this.entries],
      responseParts: this.responseParts ? [...this.responseParts] : undefined,
      prompt: this.promptRequest,
      review: this.reviewRequest,
      interrupt: () => this.requestInterrupt(),
    };
  }
}
