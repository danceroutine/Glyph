import { shellPermissionChoices } from '#src/shell/shellPermissionChoices.js';
import { Approval } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import { ApprovalCoordinator, type ApprovalResolution } from '#src/interaction/approvals/ApprovalCoordinator.js';
import type { ApprovalCapabilityPolicy } from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import { ApprovalQueue } from '#src/interaction/approvals/ApprovalQueue.js';
import type { WorkspaceScope } from '#src/interaction/approvals/ApprovalRequest.js';
import { GoalApprovalPolicy } from '#src/goals/GoalApprovalPolicy.js';
import { ModeSwitchApprovalPolicy } from '#src/interaction/modes/ModeSwitchApprovalPolicy.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
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

const defaultWorkspace: WorkspaceScope = { workspaceId: 'desktop', mutationScope: 'desktop' };

/** Routes human decisions to the originating run even when several chats execute concurrently. */
export class DesktopInteractionBroker implements QuestionPresenter, ShellPermissionPresenter {
  private readonly scope = new AsyncLocalStorage<Required<RunIdentity>>();
  private readonly pending = new Map<string, PendingDecision>();
  private readonly queues = new Map<string, ApprovalQueue>();
  private readonly approvals = new ApprovalCoordinator();
  readonly shellPermissionChoices = [
    ShellPermissionDecision.DENY,
    ShellPermissionDecision.ALLOW_ONCE,
    ShellPermissionDecision.ALWAYS_ALLOW,
    ShellPermissionDecision.ALLOW_SAFE,
    ShellPermissionDecision.DENY_AND_ALLOW_SAFE,
  ];

  constructor(
    private readonly emit: (event: GlyphHostEvent) => void,
    private readonly workspace: WorkspaceScope = defaultWorkspace,
  ) {}

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
    const id = request.approval?.id ?? randomUUID();
    return this.wait(
      id,
      identity,
      'approval',
      signal,
      value => {
        const decision = z.enum(GlyphApprovalDecision).parse(value);
        request.approval?.validateChoice(decision);
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
            choices: shellPermissionChoices(request)
              .filter(choice => this.shellPermissionChoices.includes(choice.decision))
              .map(choice => ({
                id: z.enum(GlyphApprovalDecision).parse(choice.decision),
                label: choice.label,
                description: choice.description,
              })),
          },
        });
      },
    );
  }

  presentGoalProposal(objective: string, signal: AbortSignal): Promise<boolean> {
    const identity = this.requireRun();
    const policy = new GoalApprovalPolicy();
    const approval = new Approval(policy.createRequest({ workspace: this.workspace, operation: { objective } }));
    return this.resolveApproval(approval, policy, identity, signal, () => {
      this.emit({
        type: GlyphHostEventType.APPROVAL,
        chatId: identity.chatId,
        runId: identity.runId,
        approval: {
          id: approval.id,
          title: approval.request.title,
          detail: approval.request.detail,
          sandboxed: false,
          goal: { objective },
        },
      });
    }).then(result => {
      if (result.admission === 'failed' || result.admission === 'cancelled') throw result.error;
      return result.admission === 'authorized';
    });
  }

  async presentModeSwitch(
    request: Pick<GlyphModeSwap, 'source' | 'target' | 'description'>,
    signal: AbortSignal,
    apply: () => Promise<void>,
    settle: (id: string, status: GlyphModeSwap['status']) => void,
  ): Promise<boolean> {
    const identity = this.requireRun();
    const policy = new ModeSwitchApprovalPolicy(identity.modeSwapPolicy);
    const approval = new Approval(
      policy.createRequest({
        workspace: this.workspace,
        operation: {
          source: request.source,
          target: request.target,
          explanation: request.description,
        },
      }),
    );
    let committed = false;
    try {
      const result = await this.resolveApproval(approval, policy, identity, signal, () => {
        const startedAt = Date.now();
        const modeSwap: GlyphModeSwap = {
          ...request,
          id: approval.id,
          status: GlyphModeSwapStatus.PENDING,
          autoApprove: identity.modeSwapPolicy.autoApprove,
          startedAt: new Date(startedAt).toISOString(),
          expiresAt: new Date(startedAt + identity.modeSwapPolicy.timeoutSeconds * 1000).toISOString(),
        };
        this.emit({
          type: GlyphHostEventType.APPROVAL,
          chatId: identity.chatId,
          runId: identity.runId,
          approval: {
            id: approval.id,
            title: approval.request.title,
            detail: approval.request.detail,
            sandboxed: false,
            modeSwap,
          },
        });
      });
      if (result.admission === 'failed' || result.admission === 'cancelled') throw result.error;
      const approved = result.admission === 'authorized';
      if (approved) {
        signal.throwIfAborted();
        await apply();
        committed = true;
      }
      settle(approval.id, approved ? GlyphModeSwapStatus.APPROVED : GlyphModeSwapStatus.DENIED);
      return approved;
    } catch (error) {
      settle(
        approval.id,
        committed
          ? GlyphModeSwapStatus.APPROVED
          : signal.aborted
            ? GlyphModeSwapStatus.CANCELLED
            : GlyphModeSwapStatus.FAILED,
      );
      throw error;
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

  private resolveApproval<C extends ApprovalCapability>(
    approval: Approval<C>,
    policy: ApprovalCapabilityPolicy<C>,
    identity: RunIdentity,
    signal: AbortSignal,
    publish: () => void,
  ): Promise<ApprovalResolution<C>> {
    return this.enqueue(identity, signal, () =>
      this.approvals.resolve(
        approval,
        policy,
        {
          presentApproval: (pending, cancellation, displayed) =>
            this.waitNow(
              pending.id,
              identity,
              'approval',
              cancellation,
              value => {
                const choiceId = z.string().parse(value);
                pending.validateChoice(choiceId);
                return { approvalId: pending.id, choiceId };
              },
              () => {
                displayed();
                publish();
              },
            ),
        },
        signal,
      ),
    );
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
    return this.enqueue(identity, signal, () => this.waitNow(id, identity, kind, signal, parse, publish));
  }

  private enqueue<T>(identity: RunIdentity, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const key = `${identity.chatId}\0${identity.runId}`;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new ApprovalQueue(() => {
        this.queues.delete(key);
      });
      this.queues.set(key, queue);
    }
    return queue.run(signal, operation);
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
  [GlyphApprovalDecision.ALLOW_SAFE]: ShellPermissionDecision.ALLOW_SAFE,
  [GlyphApprovalDecision.DENY_AND_ALLOW_SAFE]: ShellPermissionDecision.DENY_AND_ALLOW_SAFE,
};

const modeSwapPolicySchema = z
  .object({
    autoApprove: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(5).max(300).default(15),
  })
  .strict();
