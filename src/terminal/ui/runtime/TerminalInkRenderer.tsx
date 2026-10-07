import { EventEmitter } from 'node:events';
import type { ReactNode } from 'react';
import { render } from 'ink';
import type { Instance } from 'ink';
import type { ChatResponsePart } from '../../../chat/ChatResponsePart.ts';
import type { WorkspacePathIndex } from '../../../context/search/WorkspacePathIndex.ts';
import type { ProposalReviewManager } from '../../../editing/reviews/ProposalReviewManager.ts';
import type { QuestionForm } from '../../../interaction/questions/QuestionForm.ts';
import type { QuestionFormResult } from '../../../interaction/questions/QuestionFormResult.ts';
import { Deferred } from './Deferred.ts';
import { PromptRecord } from '../prompt/PromptRecord.presentational.tsx';
import type { PromptRequest } from '../prompt/PromptRequest.ts';
import type { UserPromptDraft } from '../prompt/UserPromptDraft.ts';
import type { ProposalReviewRequest } from '../proposal/ProposalReviewRequest.ts';
import { ProposalReviewReceipt } from '../proposal/ProposalReviewReceipt.presentational.tsx';
import type { ProposalReviewSummary } from '../proposal/ProposalReviewSummary.ts';
import type { TerminalInputStream } from './TerminalInputStream.ts';
import type { TerminalOutputStream } from './TerminalOutputStream.ts';
import type { TerminalRendererSnapshot } from '../shell/TerminalRendererSnapshot.ts';
import { WiredTerminalRoot } from '../shell/TerminalRoot.wired.tsx';
import type { TranscriptEntry } from '../shell/TranscriptEntry.ts';
import { WiredResponse } from '../response/Response.wired.tsx';
import type { QuestionFormRequest } from '../question/QuestionFormRequest.ts';
import { QuestionFormReceipt } from '../question/QuestionFormReceipt.presentational.tsx';

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
  private questionRequest: QuestionFormRequest | undefined;
  private reviewRequest: ProposalReviewRequest | undefined;
  private promptResult: Deferred<UserPromptDraft> | undefined;
  private questionResult: Deferred<QuestionFormResult> | undefined;
  private reviewResult: Deferred<void> | undefined;
  private chatPromptContext: {
    label: string;
    files?: WorkspacePathIndex;
    pendingChanges: number;
  } = { label: 'you> ', pendingChanges: 0 };
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
    this.instance = render(<WiredTerminalRoot snapshot={this.snapshot()} />, {
      stdin: input,
      stdout: output,
      stderr: errorOutput,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      // The full-height layout can move response rows between frames. A full
      // redraw prevents incremental line diffs from leaving transient UI,
      // such as the thinking pulser, behind after completion.
      incrementalRendering: false,
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

  replaceTranscript(content: ReactNode): void {
    this.entries.length = 0;
    this.entries.push({ id: this.nextId++, content });
    this.responseParts = undefined;
    this.refresh();
  }

  beginResponse(): void {
    this.responseParts = [];
    if (!this.promptRequest && !this.questionRequest && !this.reviewRequest) {
      this.promptRequest = {
        id: this.nextId++,
        label: this.chatPromptContext.label,
        acceptsSubmission: false,
        pendingChanges: this.chatPromptContext.pendingChanges,
        ...(this.chatPromptContext.files ? { files: this.chatPromptContext.files } : {}),
      };
    }
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
      content: <WiredResponse parts={parts} footer={footer} />,
    });
    this.refresh();
  }

  async prompt(
    label: string,
    signal: AbortSignal,
    files?: WorkspacePathIndex,
    pendingChanges = 0,
  ): Promise<UserPromptDraft> {
    const draftRequest =
      this.promptRequest?.acceptsSubmission === false && this.promptRequest.label === label
        ? this.promptRequest
        : undefined;
    this.assertAvailable(draftRequest);
    signal.throwIfAborted();
    if (label === 'you> ') {
      this.chatPromptContext = { label, pendingChanges, ...(files ? { files } : {}) };
    }
    const result = new Deferred<UserPromptDraft>();
    this.promptResult = result;
    const id = draftRequest?.id ?? this.nextId++;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      if (this.promptRequest?.id !== id) return;
      this.promptRequest = undefined;
      this.promptResult = undefined;
      cleanup();
      this.refresh();
      result.reject(signal.reason ?? new Error('Input cancelled.'));
    };
    this.promptRequest = {
      id,
      label,
      acceptsSubmission: true,
      pendingChanges,
      ...(files ? { files } : {}),
      complete: draft => {
        if (this.promptRequest?.id !== id) return;
        this.promptRequest = undefined;
        this.promptResult = undefined;
        cleanup();
        this.entries.push({
          id,
          content: (
            <PromptRecord
              label={label}
              draft={draft}
              maxWidth={Math.max(3, Math.floor((this.output.columns ?? 80) * 0.8))}
            />
          ),
        });
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
    const draftRequest = this.promptRequest?.acceptsSubmission === false ? this.promptRequest : undefined;
    this.assertAvailable(draftRequest);
    signal.throwIfAborted();
    const result = new Deferred<void>();
    this.reviewResult = result;
    const id = this.nextId++;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const complete = (summary?: ProposalReviewSummary): void => {
      if (this.reviewRequest?.id !== id) return;
      this.reviewRequest = undefined;
      this.reviewResult = undefined;
      cleanup();
      if (summary) this.entries.push({ id, content: <ProposalReviewReceipt {...summary} /> });
      this.refresh();
      result.resolve();
    };
    const abort = (): void => {
      if (this.reviewRequest?.id !== id) return;
      this.reviewRequest = undefined;
      this.reviewResult = undefined;
      cleanup();
      this.refresh();
      result.reject(signal.reason ?? new Error('Review cancelled.'));
    };
    this.reviewRequest = { id, manager, complete, interrupt };
    signal.addEventListener('abort', abort, { once: true });
    this.refresh();
    return result.promise;
  }

  async presentQuestionForm(
    form: QuestionForm,
    signal: AbortSignal,
    interrupt: () => void,
  ): Promise<QuestionFormResult> {
    const draftRequest = this.promptRequest?.acceptsSubmission === false ? this.promptRequest : undefined;
    this.assertAvailable(draftRequest);
    signal.throwIfAborted();
    const result = new Deferred<QuestionFormResult>();
    this.questionResult = result;
    const id = this.nextId++;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const complete = (formResult: QuestionFormResult): void => {
      if (this.questionRequest?.id !== id) return;
      this.questionRequest = undefined;
      this.questionResult = undefined;
      cleanup();
      this.entries.push({ id, content: <QuestionFormReceipt form={form} result={formResult} /> });
      this.refresh();
      result.resolve(formResult);
    };
    const abort = (): void => {
      if (this.questionRequest?.id !== id) return;
      this.questionRequest = undefined;
      this.questionResult = undefined;
      cleanup();
      this.refresh();
      result.reject(signal.reason ?? new Error('Question cancelled.'));
    };
    this.questionRequest = { id, form, complete, interrupt };
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
    const cancellation = new Error('Session closed.');
    this.promptResult?.reject(cancellation);
    this.questionResult?.reject(cancellation);
    this.reviewResult?.reject(cancellation);
    this.promptResult = undefined;
    this.questionResult = undefined;
    this.reviewResult = undefined;
    this.promptRequest = undefined;
    this.questionRequest = undefined;
    this.reviewRequest = undefined;
    this.input.off('end', this.handleInputClosed);
    this.input.off('close', this.handleInputClosed);
    this.instance.cleanup();
  }

  private assertAvailable(reusablePrompt?: PromptRequest): void {
    if (this.closed) throw new Error('Session closed.');
    if ((this.promptRequest && this.promptRequest !== reusablePrompt) || this.questionRequest || this.reviewRequest) {
      throw new Error('The terminal is already waiting for input.');
    }
  }

  private refresh(): void {
    if (this.closed) return;
    this.instance.rerender(<WiredTerminalRoot snapshot={this.snapshot()} />);
  }

  private snapshot(): TerminalRendererSnapshot {
    return {
      entries: [...this.entries],
      responseParts: this.responseParts ? [...this.responseParts] : undefined,
      prompt: this.promptRequest,
      ...(this.questionRequest ? { question: this.questionRequest } : {}),
      review: this.reviewRequest,
      interrupt: () => this.requestInterrupt(),
    };
  }
}
