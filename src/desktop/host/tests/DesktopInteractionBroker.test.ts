import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';

const form = {
  questions: [
    {
      id: 'color',
      prompt: 'Which color?',
      allowMultiple: false,
      options: [
        { id: 'red', label: 'Red' },
        { id: 'blue', label: 'Blue' },
      ],
    },
  ],
};
describe(DesktopInteractionBroker, () => {
  it('cancels a queued decision without answering or bypassing the decision already displayed for its run', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const lastController = new AbortController();
    const identity = { chatId: 'chat', runId: 'run' };
    const first = broker
      .run(identity, () => broker.present(form, firstController.signal))
      .catch((error: unknown) => error);
    let queuedError: unknown;
    const queued = broker
      .run(identity, () => broker.present(form, queuedController.signal))
      .catch(error => {
        queuedError = error;
      });
    const last = broker
      .run(identity, () => broker.present(form, lastController.signal))
      .catch((error: unknown) => error);
    try {
      const cancelled = new Error('Queued question cancelled.');
      queuedController.abort(cancelled);
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect.soft(queuedError).toBe(cancelled);
      expect(events).toHaveLength(1);
      const question = events[0];
      if (question?.type !== GlyphHostEventType.QUESTION) throw new Error('Expected the first question.');
      const answer = { answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }] };
      broker.answer({ ...identity, id: question.question.id, kind: 'question', value: answer });
      await expect(first).resolves.toEqual(answer);
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(events).toHaveLength(2);
      expect(firstController.signal.aborted).toBe(false);
    } finally {
      firstController.abort();
      queuedController.abort();
      lastController.abort();
      await Promise.all([first, queued, last]);
    }
  });

  it('queues concurrent human decisions so the recoverable run exposes every question in order', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const signal = new AbortController().signal;
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      Promise.all([broker.present(form, signal), broker.present(form, signal)]),
    );
    expect(events).toHaveLength(1);
    const answer = (event: GlyphHostEvent | undefined) => {
      if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
      broker.answer({
        chatId: 'chat',
        runId: 'run',
        id: event.question.id,
        kind: 'question',
        value: { answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }] },
      });
    };
    answer(events[0]);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(2);
    answer(events[1]);
    await expect(result).resolves.toHaveLength(2);
  });

  it('rejects answers from another chat and keeps malformed answers available for correction', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.present(form, new AbortController().signal),
    );
    const event = events[0];
    if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
    const input = {
      chatId: 'chat',
      runId: 'run',
      id: event.question.id,
      kind: 'question' as const,
      value: { answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }] },
    };
    expect(() => {
      broker.answer({ ...input, chatId: 'other' });
    }).toThrow('no longer pending');
    expect(() => {
      broker.answer({ ...input, value: { answers: [] } });
    }).toThrow('exactly once');
    broker.answer(input);
    await expect(result).resolves.toEqual(input.value);
    expect(() => {
      broker.answer(input);
    }).toThrow('no longer pending');
  });

  it('cancels a pending question without leaving an answerable request behind', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const controller = new AbortController();
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () => broker.present(form, controller.signal));
    const rejected = expect(result).rejects.toThrow('stopped');
    controller.abort(new Error('stopped'));
    await rejected;
    const event = events[0];
    if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
    expect(() => {
      broker.answer({ chatId: 'chat', runId: 'run', id: event.question.id, kind: 'question', value: {} });
    }).toThrow('no longer pending');
  });

  it('grants a shell approval only once without upgrading it to permanent or unrestricted access', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.presentShellPermission({ command: 'test', workingDirectory: '/project' }, new AbortController().signal),
    );
    const event = events[0];
    if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Approval was not published');
    broker.answer({
      chatId: 'chat',
      runId: 'run',
      id: event.approval.id,
      kind: 'approval',
      value: GlyphApprovalDecision.ALLOW_ONCE,
    });
    await expect(result).resolves.toBe(ShellPermissionDecision.ALLOW_ONCE);
  });
  it('limits remembered approvals to the explicit desktop choices and rejects replay or wrong-run decisions', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.presentShellPermission(
        { command: 'echo approved', workingDirectory: '/project' },
        new AbortController().signal,
      ),
    );
    const event = events[0];
    if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Expected approval');
    expect(event.approval).toMatchObject({
      command: 'echo approved',
      workingDirectory: '/project',
      canRemember: true,
      sandboxed: true,
    });
    const input = {
      chatId: 'chat',
      runId: 'run',
      id: event.approval.id,
      kind: 'approval' as const,
      value: GlyphApprovalDecision.ALWAYS_ALLOW,
    };
    expect(() => {
      broker.answer({ ...input, value: ShellPermissionDecision.ALLOW_EVERYTHING });
    }).toThrow();
    expect(() => {
      broker.answer({ ...input, value: ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE });
    }).toThrow();
    expect(() => {
      broker.answer({ ...input, runId: 'other' });
    }).toThrow('no longer pending');
    broker.answer(input);
    await expect(result).resolves.toBe(ShellPermissionDecision.ALWAYS_ALLOW);
    expect(() => {
      broker.answer(input);
    }).toThrow('no longer pending');
  });

  it('rejects a late approval after cancellation without granting permission', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => {
      events.push(event);
    });
    const controller = new AbortController();
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.presentShellPermission({ command: 'echo cancelled', workingDirectory: '/project' }, controller.signal),
    );
    const rejected = expect(result).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    const event = events[0];
    if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Expected approval');
    expect(() => {
      broker.answer({
        chatId: 'chat',
        runId: 'run',
        id: event.approval.id,
        kind: 'approval',
        value: GlyphApprovalDecision.ALLOW_ONCE,
      });
    }).toThrow('no longer pending');
  });

  describe(DesktopInteractionBroker.prototype.present, () => {
    it('requires an active chat run', async () => {
      const broker = new DesktopInteractionBroker(() => {});
      await expect(broker.present(form, new AbortController().signal)).rejects.toThrow(
        'Human interaction requires an active chat run.',
      );
    });

    it('publishes the titled form and accepts free-text and multiple-choice answers', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const questions = [
        { id: 'why', prompt: 'Why?', allowMultiple: false, options: [{ id: 'because', label: 'Because' }] },
        {
          id: 'sizes',
          prompt: 'Which sizes?',
          allowMultiple: true,
          options: [
            { id: 's', label: 'Small' },
            { id: 'l', label: 'Large' },
          ],
        },
      ];
      const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
        broker.present({ title: 'Details', questions }, new AbortController().signal),
      );
      const event = events[0];
      if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
      expect(event).toEqual({
        type: GlyphHostEventType.QUESTION,
        chatId: 'chat',
        runId: 'run',
        modeSwapPolicy: { autoApprove: false, timeoutSeconds: 15 },
        question: { id: event.question.id, title: 'Details', prompt: 'Why?\nWhich sizes?', questions },
      });
      const value = {
        answers: [
          { questionId: 'why', type: QuestionAnswerType.OTHER, text: 'Clarity' },
          { questionId: 'sizes', type: QuestionAnswerType.SELECTION, optionIds: ['s', 'l'] },
        ],
      };
      broker.answer({ chatId: 'chat', runId: 'run', id: event.question.id, kind: 'question', value });
      await expect(result).resolves.toEqual(value);
    });

    it.each([
      [
        'an answer for an unknown question',
        { questionId: 'size', type: QuestionAnswerType.SELECTION, optionIds: ['red'] },
        'An answer is missing.',
      ],
      [
        'several options for a single-choice question',
        { questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red', 'blue'] },
        'The selected answer is invalid.',
      ],
      [
        'an option that was not offered',
        { questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['green'] },
        'The selected answer is invalid.',
      ],
    ])('refuses %s and keeps the question open', async (_label, answer, message) => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const controller = new AbortController();
      const result = broker.run({ chatId: 'chat', runId: 'run' }, () => broker.present(form, controller.signal));
      const event = events[0];
      if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
      const input = { chatId: 'chat', runId: 'run', id: event.question.id, kind: 'question' as const };
      expect(() => {
        broker.answer({ ...input, value: { answers: [answer] } });
      }).toThrow(message);
      const valid = { answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['blue'] }] };
      broker.answer({ ...input, value: valid });
      await expect(result).resolves.toEqual(valid);
    });

    it('rejects a queued question whose signal was already cancelled', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const identity = { chatId: 'chat', runId: 'run' };
      const active = new AbortController();
      const first = broker.run(identity, () => broker.present(form, active.signal));
      const cancelled = new AbortController();
      const reason = new Error('Already stopped');
      cancelled.abort(reason);
      await expect(broker.run(identity, () => broker.present(form, cancelled.signal))).rejects.toBe(reason);
      const rejected = expect(first).rejects.toThrow('done');
      active.abort(new Error('done'));
      await rejected;
      expect(events).toHaveLength(1);
    });

    it('reports a generic cancellation when a displayed question is cancelled without a reason', async () => {
      const broker = new DesktopInteractionBroker(() => {});
      const controller = new AbortController();
      Object.defineProperty(controller.signal, 'reason', { value: undefined });
      const result = broker.run({ chatId: 'chat', runId: 'run' }, () => broker.present(form, controller.signal));
      const rejected = expect(result).rejects.toThrow('Run cancelled.');
      controller.abort();
      await rejected;
    });

    it('reports a generic cancellation when a queued question is cancelled without a reason', async () => {
      const broker = new DesktopInteractionBroker(() => {});
      const identity = { chatId: 'chat', runId: 'run' };
      const active = new AbortController();
      const first = broker.run(identity, () => broker.present(form, active.signal)).catch((error: unknown) => error);
      const controller = new AbortController();
      Object.defineProperty(controller.signal, 'reason', { value: undefined });
      const queued = broker.run(identity, () => broker.present(form, controller.signal));
      const rejected = expect(queued).rejects.toThrow('Run cancelled.');
      controller.abort();
      await rejected;
      active.abort();
      await first;
    });

    it('withdraws the question when it cannot be published', async () => {
      const broker = new DesktopInteractionBroker(() => {
        throw new Error('Window closed');
      });
      const identity = { chatId: 'chat', runId: 'run' };
      await expect(broker.run(identity, () => broker.present(form, new AbortController().signal))).rejects.toThrow(
        'Window closed',
      );
    });
  });

  describe(DesktopInteractionBroker.prototype.presentShellPermission, () => {
    it('requires an active chat run', () => {
      const broker = new DesktopInteractionBroker(() => {});
      expect(() =>
        broker.presentShellPermission({ command: 'ls', workingDirectory: '/project' }, new AbortController().signal),
      ).toThrow('Human interaction requires an active chat run.');
    });
  });

  describe(DesktopInteractionBroker.prototype.presentModeSwitch, () => {
    it('applies the default fifteen second policy when the run has none', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const settle = vi.fn();
      const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
        broker.presentModeSwitch(
          { source: AgentModeID.PLAN, target: AgentModeID.AGENT, description: 'Build it' },
          new AbortController().signal,
          async () => {},
          settle,
        ),
      );
      const event = events[0];
      if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Approval was not published');
      const modeSwap = event.approval.modeSwap!;
      expect(modeSwap.autoApprove).toBe(false);
      expect(Date.parse(modeSwap.expiresAt) - Date.parse(modeSwap.startedAt!)).toBe(15_000);
      broker.answer({
        chatId: 'chat',
        runId: 'run',
        id: event.approval.id,
        kind: 'approval',
        value: GlyphApprovalDecision.DENY,
      });
      await expect(result).resolves.toBe(false);
      expect(settle).toHaveBeenCalledExactlyOnceWith(event.approval.id, GlyphModeSwapStatus.DENIED);
    });

    it('reports a committed switch as approved even when recording the outcome fails', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const apply = vi.fn(async () => {});
      const settle = vi.fn<(id: string, status: GlyphModeSwapStatus) => void>().mockImplementationOnce(() => {
        throw new Error('Persist failed');
      });
      const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
        broker.presentModeSwitch(
          { source: AgentModeID.PLAN, target: AgentModeID.AGENT, description: 'Build it' },
          new AbortController().signal,
          apply,
          settle,
        ),
      );
      const event = events[0];
      if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Approval was not published');
      broker.answer({
        chatId: 'chat',
        runId: 'run',
        id: event.approval.id,
        kind: 'approval',
        value: GlyphApprovalDecision.ALLOW_ONCE,
      });
      await expect(result).rejects.toThrow('Persist failed');
      expect(apply).toHaveBeenCalledOnce();
      expect(settle.mock.calls).toEqual([
        [event.approval.id, GlyphModeSwapStatus.APPROVED],
        [event.approval.id, GlyphModeSwapStatus.APPROVED],
      ]);
    });

    it('settles as cancelled without publishing when the run was already cancelled', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => {
        events.push(event);
      });
      const controller = new AbortController();
      controller.abort(new Error('Stopped'));
      const settle = vi.fn();
      await expect(
        broker.run({ chatId: 'chat', runId: 'run' }, () =>
          broker.presentModeSwitch(
            { source: AgentModeID.PLAN, target: AgentModeID.AGENT, description: 'Build it' },
            controller.signal,
            async () => {},
            settle,
          ),
        ),
      ).rejects.toThrow('Stopped');
      expect(events).toEqual([]);
      expect(settle).toHaveBeenCalledExactlyOnceWith(expect.any(String), GlyphModeSwapStatus.CANCELLED);
    });

    it('requires an active chat run', async () => {
      const broker = new DesktopInteractionBroker(() => {});
      await expect(
        broker.presentModeSwitch(
          { source: AgentModeID.PLAN, target: AgentModeID.AGENT, description: 'Build it' },
          new AbortController().signal,
          async () => {},
          () => {},
        ),
      ).rejects.toThrow('Human interaction requires an active chat run.');
    });
  });
});
