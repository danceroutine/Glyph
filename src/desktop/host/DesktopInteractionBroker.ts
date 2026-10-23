import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import type { GlyphModeSwap, GlyphModeSwapPolicy } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QuestionPresenter } from '#src/interaction/questions/QuestionPresenter.js';
import type { QuestionForm } from '#src/interaction/questions/QuestionForm.js';
import type { QuestionFormResult } from '#src/interaction/questions/QuestionFormResult.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import type { ShellPermissionPresenter } from '#src/shell/ShellPermissionPresenter.js';
import type { ShellPermissionRequest } from '#src/shell/ShellPermissionRequest.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { questionAnswersSchema } from '#src/interaction/questions/questionAnswersSchema.js';

interface RunIdentity {
  readonly chatId: string;
  readonly runId: string;
  readonly modeSwapPolicy?: GlyphModeSwapPolicy;
}
interface PendingDecision extends RunIdentity {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly kind: 'question' | 'approval';
}

/** Routes human decisions to the originating run even when several chats execute concurrently. */
export class DesktopInteractionBroker implements QuestionPresenter, ShellPermissionPresenter {
  private readonly scope = new AsyncLocalStorage<Required<RunIdentity>>();
  private readonly pending = new Map<string, PendingDecision>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly emit: (event: GlyphHostEvent) => void) {}

  run<T>(identity: RunIdentity, operation: () => Promise<T>): Promise<T> {
    return this.scope.run(
      {
        chatId: identity.chatId,
        runId: identity.runId,
        modeSwapPolicy: modeSwapPolicySchema.parse(identity.modeSwapPolicy ?? {}),
      },
      operation,
    );
  }

  async present(form: QuestionForm, signal: AbortSignal): Promise<QuestionFormResult> {
    const identity = this.requireRun();
    const id = randomUUID();
    return this.wait(
      id,
      identity,
      'question',
      signal,
      value => {
        const result = questionAnswersSchema.parse(value);
        if (
          result.answers.length !== form.questions.length ||
          new Set(result.answers.map(answer => answer.questionId)).size !== result.answers.length
        ) {
          throw new Error('Answer every question exactly once.');
        }
        for (const question of form.questions) {
          const answer = result.answers.find(candidate => candidate.questionId === question.id);
          if (!answer) throw new Error('An answer is missing.');
          if (
            answer.type === QuestionAnswerType.SELECTION &&
            ((!question.allowMultiple && answer.optionIds.length !== 1) ||
              answer.optionIds.some(optionId => !question.options.some(option => option.id === optionId)))
          )
            throw new Error('The selected answer is invalid.');
        }
        return result;
      },
      () => {
        this.emit({
          type: GlyphHostEventType.QUESTION,
          ...identity,
          question: {
            id,
            title: form.title ?? 'Question',
            prompt: form.questions.map(question => question.prompt).join('\n'),
            questions: form.questions,
          },
        });
      },
    );
  }

  presentShellPermission(request: ShellPermissionRequest, signal: AbortSignal): Promise<ShellPermissionDecision> {
    const identity = this.requireRun();
    const id = randomUUID();
    return this.wait(
      id,
      identity,
      'approval',
      signal,
      value => {
        const decision = z.enum(GlyphApprovalDecision).parse(value);
        return GLYPH_APPROVAL_TO_SHELL_PERMISSION[decision];
      },
      () => {
        this.emit({
          type: GlyphHostEventType.APPROVAL,
          ...identity,
          approval: {
            id,
            title: 'Allow shell command?',
            detail: `${request.command}\nWorking directory: ${request.workingDirectory}`,
            sandboxed: true,
            command: request.command,
            workingDirectory: request.workingDirectory,
            canRemember: true,
          },
        });
      },
    );
  }

  presentGoalProposal(objective: string, signal: AbortSignal): Promise<boolean> {
    const identity = this.requireRun();
    const id = randomUUID();
    return this.wait(
      id,
      identity,
      'approval',
      signal,
      value =>
        z.enum([GlyphApprovalDecision.ALLOW_ONCE, GlyphApprovalDecision.DENY]).parse(value) ===
        GlyphApprovalDecision.ALLOW_ONCE,
      () => {
        this.emit({
          type: GlyphHostEventType.APPROVAL,
          chatId: identity.chatId,
          runId: identity.runId,
          approval: {
            id,
            title: 'Start a goal?',
            detail: objective,
            sandboxed: false,
            goal: { objective },
          },
        });
      },
    );
  }

  async presentModeSwitch(
    request: Pick<GlyphModeSwap, 'source' | 'target' | 'description'>,
    signal: AbortSignal,
    apply: () => Promise<void>,
    settle: (id: string, status: GlyphModeSwap['status']) => void,
  ): Promise<boolean> {
    const identity = this.requireRun();
    const policy = identity.modeSwapPolicy;
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    try {
      const approved = await this.wait(
        id,
        identity,
        'approval',
        signal,
        value => {
          return (
            z.enum([GlyphApprovalDecision.ALLOW_ONCE, GlyphApprovalDecision.DENY]).parse(value) ===
            GlyphApprovalDecision.ALLOW_ONCE
          );
        },
        () => {
          const startedAt = Date.now();
          const modeSwap: GlyphModeSwap = {
            ...request,
            id,
            status: GlyphModeSwapStatus.PENDING,
            autoApprove: policy.autoApprove,
            startedAt: new Date(startedAt).toISOString(),
            expiresAt: new Date(startedAt + policy.timeoutSeconds * 1000).toISOString(),
          };
          this.emit({
            type: GlyphHostEventType.APPROVAL,
            chatId: identity.chatId,
            runId: identity.runId,
            approval: {
              id,
              title: `Switch to ${AgentMode.resolve(request.target).title}`,
              detail: request.description,
              sandboxed: false,
              modeSwap,
            },
          });
          timer = setTimeout(() => {
            this.pending
              .get(id)
              ?.resolve(policy.autoApprove ? GlyphApprovalDecision.ALLOW_ONCE : GlyphApprovalDecision.DENY);
          }, policy.timeoutSeconds * 1000);
        },
      );
      if (approved) {
        signal.throwIfAborted();
        await apply();
        committed = true;
      }
      settle(id, approved ? GlyphModeSwapStatus.APPROVED : GlyphModeSwapStatus.DENIED);
      return approved;
    } catch (error) {
      settle(
        id,
        committed
          ? GlyphModeSwapStatus.APPROVED
          : signal.aborted
            ? GlyphModeSwapStatus.CANCELLED
            : GlyphModeSwapStatus.FAILED,
      );
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  answer(
    input: RunIdentity & { readonly id: string; readonly kind: PendingDecision['kind']; readonly value: unknown },
  ): void {
    const pending = this.pending.get(input.id);
    if (!pending || pending.chatId !== input.chatId || pending.runId !== input.runId || pending.kind !== input.kind) {
      throw new Error('This decision is no longer pending for that run.');
    }
    pending.resolve(input.value);
  }

  private requireRun(): Required<RunIdentity> {
    const identity = this.scope.getStore();
    if (!identity) throw new Error('Human interaction requires an active chat run.');
    return identity;
  }

  private wait<T>(
    id: string,
    identity: RunIdentity,
    kind: PendingDecision['kind'],
    signal: AbortSignal,
    parse: (value: unknown) => T,
    publish: () => void,
  ): Promise<T> {
    // A run exposes one human decision at a time; parallel tool calls queue
    // here so a reconnect snapshot never loses an unanswered form.
    const key = `${identity.chatId}\0${identity.runId}`;
    const previous = this.queues.get(key);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        reject(signal.reason ?? new Error('Run cancelled.'));
      };
      if (previous) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      const start = () => {
        signal.removeEventListener('abort', abort);
        return this.waitNow(id, identity, kind, signal, parse, publish);
      };
      const result = previous ? previous.then(start) : start();
      // Keep the queue tied to the displayed decision, not to a queued caller
      // cancelling its wait. Otherwise a later question could replace the
      // still-unanswered form in the run's recoverable state.
      const settled = result.then(
        () => {},
        () => {},
      );
      this.queues.set(key, settled);
      void settled.then(() => {
        if (this.queues.get(key) === settled) this.queues.delete(key);
      });
      void result.then(resolve, reject);
    });
  }

  private waitNow<T>(
    id: string,
    identity: RunIdentity,
    kind: PendingDecision['kind'],
    signal: AbortSignal,
    parse: (value: unknown) => T,
    publish: () => void,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason ?? new Error('Run cancelled.'));
      };
      this.pending.set(id, {
        ...identity,
        kind,
        reject,
        resolve: value => {
          // Parse before removing the request: malformed answers can be corrected.
          const parsed = parse(value);
          cleanup();
          resolve(parsed);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        publish();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

const GLYPH_APPROVAL_TO_SHELL_PERMISSION: Record<GlyphApprovalDecision, ShellPermissionDecision> = {
  [GlyphApprovalDecision.DENY]: ShellPermissionDecision.DENY,
  [GlyphApprovalDecision.ALLOW_ONCE]: ShellPermissionDecision.ALLOW_ONCE,
  [GlyphApprovalDecision.ALWAYS_ALLOW]: ShellPermissionDecision.ALWAYS_ALLOW,
};

const modeSwapPolicySchema = z
  .object({
    autoApprove: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(5).max(300).default(15),
  })
  .strict();
