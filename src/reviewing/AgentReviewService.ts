import {
  AgentReviewStatus as Status,
  type AgentReview,
  type AgentReviewInput,
  type AgentReviewModel,
} from './AgentReview.ts';
import type { AgentReviewExecutor } from './AgentReviewExecutor.ts';
import type { AgentReviewStore } from './AgentReviewStore.ts';
import { agentReviewInputSchema } from './AgentReviewSchema.ts';
import { parseAgentReviewFindings, type AgentReviewFileLines } from './parseAgentReviewFindings.ts';

/** Serializes durable transitions independently of chat sessions and renderer lifetimes. */
export class AgentReviewService {
  private readonly records = new Map<string, AgentReview>();
  private readonly listeners = new Set<(review: AgentReview) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private active: { id: string; controller: AbortController; completion: Promise<void> } | undefined;
  private closed = false;
  constructor(
    private readonly store: AgentReviewStore,
    private readonly executor: AgentReviewExecutor,
  ) {}
  get reviews(): readonly AgentReview[] {
    return [...this.records.values()];
  }
  onDidChange(listener: (review: AgentReview) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async initialize(): Promise<void> {
    for (const review of await this.store.load()) {
      this.records.set(review.id, review);
      if (review.status === Status.RUNNING)
        await this.commit({
          ...review,
          status: Status.INTERRUPTED,
          error: 'The review was interrupted when the host stopped. Review again to retry.',
        });
    }
  }
  start(input: AgentReviewInput, model: AgentReviewModel): Promise<void> {
    return this.serial(async () => {
      if (this.closed) throw new Error('Review service has stopped.');
      const capture = agentReviewInputSchema.parse(input);
      const previous = this.records.get(capture.id);
      if (previous) {
        if (JSON.stringify(previous.files) !== JSON.stringify(capture.files))
          throw new Error('Review ID already belongs to another capture.');
        return;
      }
      if (this.active) throw new Error('A review is already running. Stop it before starting another.');
      const createdAt = new Date().toISOString();
      const review: AgentReview = {
        ...capture,
        ...model,
        status: Status.RUNNING,
        createdAt,
        updatedAt: createdAt,
        findings: [],
        dismissedIds: [],
        summary: '',
      };
      // Admission must reach disk before any provider request can start.
      await this.commit(review);
      const controller = new AbortController();
      const completion = Promise.resolve().then(() => this.execute(review, controller.signal));
      this.active = { id: review.id, controller, completion };
      void completion.finally(() => {
        this.active = undefined;
      });
    });
  }
  cancel(id: string): Promise<void> {
    return this.serial(async () => {
      const review = this.require(id);
      if (review.status !== Status.RUNNING) return;
      this.active?.controller.abort(new Error('Review cancelled.'));
      await this.commit({ ...review, status: Status.CANCELLED });
    });
  }
  dismiss(id: string, findingId: string): Promise<void> {
    return this.serial(async () => {
      const review = this.require(id);
      if (!review.findings.some(finding => finding.id === findingId))
        throw new Error('The review finding is unavailable.');
      if (!review.dismissedIds.includes(findingId))
        await this.commit({ ...review, dismissedIds: [...review.dismissedIds, findingId] });
    });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      if (!this.active) return;
      const review = this.require(this.active.id);
      this.active.controller.abort(new Error('Review host stopped.'));
      if (review.status === Status.RUNNING)
        await this.commit({
          ...review,
          status: Status.INTERRUPTED,
          error: 'The review host stopped. Review again to retry.',
        });
    });
    await this.active?.completion;
    await this.queue;
    this.listeners.clear();
    await this.store.dispose();
  }
  private async execute(review: AgentReview, signal: AbortSignal): Promise<void> {
    let text = '';
    let progress: Promise<unknown> = Promise.resolve();
    const files = new Map<string, AgentReviewFileLines>(
      review.files.map(file => [
        file.path,
        {
          original: file.before.split('\n').length,
          modified: file.after.split('\n').length,
          defaultSide: file.after ? 'modified' : 'original',
        },
      ]),
    );
    try {
      signal.throwIfAborted();
      await this.executor.run(
        review,
        delta => {
          signal.throwIfAborted();
          text += delta;
          if (text.length > 1024 * 1024) throw new Error('Review output exceeded its limit.');
          const parsed = parseAgentReviewFindings(text, files);
          progress = this.serial(async () => {
            const current = this.require(review.id);
            if (current.status !== Status.RUNNING || signal.aborted) return;
            if (JSON.stringify(parsed.findings) !== JSON.stringify(current.findings))
              await this.commit({ ...current, findings: parsed.findings });
          });
          // A failed checkpoint aborts inference; the error is surfaced below.
          void progress.catch(error => {
            this.active?.controller.abort(error);
          });
        },
        signal,
      );
      await progress;
      await this.serial(async () => {
        const current = this.require(review.id);
        if (current.status !== Status.RUNNING) return;
        signal.throwIfAborted();
        const result = parseAgentReviewFindings(text, files);
        const summary = text.replace(/<glyph_review>[\s\S]*?(?:<\/glyph_review>|$)/g, '').trim();
        await this.commit({
          ...current,
          findings: result.findings,
          summary,
          status: result.complete ? Status.COMPLETED : Status.FAILED,
          ...(!result.complete
            ? { error: 'The model did not return a complete, valid review report. Review again to retry.' }
            : {}),
        });
      });
    } catch (error) {
      try {
        await this.serial(async () => {
          const current = this.require(review.id);
          if (current.status !== Status.RUNNING) return;
          await this.commit({
            ...current,
            status: Status.FAILED,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch {
        // Keep the failure visible even if disk became unavailable. A restart
        // sees the last durable running checkpoint and marks it interrupted.
        const failed = {
          ...this.require(review.id),
          status: Status.FAILED,
          error: 'Review results could not be saved. Check available storage before retrying.',
        };
        this.records.set(review.id, failed);
        this.listeners.forEach(listener => listener(failed));
      }
    }
  }
  private require(id: string): AgentReview {
    const review = this.records.get(id);
    if (!review) throw new Error('The review is unavailable.');
    return review;
  }
  private async commit(review: AgentReview): Promise<void> {
    const next = { ...review, updatedAt: new Date().toISOString() };
    await this.store.save(next);
    this.records.set(next.id, next);
    this.listeners.forEach(listener => listener(next));
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }
}
