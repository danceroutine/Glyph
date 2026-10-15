import { describe, expect, it } from 'vitest';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
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
    const broker = new DesktopInteractionBroker(event => events.push(event));
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const lastController = new AbortController();
    const identity = { chatId: 'chat', runId: 'run' };
    const first = broker.run(identity, () => broker.present(form, firstController.signal)).catch(error => error);
    let queuedError: unknown;
    const queued = broker
      .run(identity, () => broker.present(form, queuedController.signal))
      .catch(error => {
        queuedError = error;
      });
    const last = broker.run(identity, () => broker.present(form, lastController.signal)).catch(error => error);
    try {
      const cancelled = new Error('Queued question cancelled.');
      queuedController.abort(cancelled);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(queuedError).toBe(cancelled);
      expect(events).toHaveLength(1);
      const question = events[0];
      if (question?.type !== GlyphHostEventType.QUESTION) throw new Error('Expected the first question.');
      const answer = { answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }] };
      broker.answer({ ...identity, id: question.question.id, kind: 'question', value: answer });
      await expect(first).resolves.toEqual(answer);
      await new Promise<void>(resolve => setImmediate(resolve));
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
    const broker = new DesktopInteractionBroker(event => events.push(event));
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
    const broker = new DesktopInteractionBroker(event => events.push(event));
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
    expect(() => broker.answer({ ...input, chatId: 'other' })).toThrow('no longer pending');
    expect(() => broker.answer({ ...input, value: { answers: [] } })).toThrow('exactly once');
    broker.answer(input);
    await expect(result).resolves.toEqual(input.value);
    expect(() => broker.answer(input)).toThrow('no longer pending');
  });

  it('cancels a pending question without leaving an answerable request behind', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => events.push(event));
    const controller = new AbortController();
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () => broker.present(form, controller.signal));
    const rejected = expect(result).rejects.toThrow('stopped');
    controller.abort(new Error('stopped'));
    await rejected;
    const event = events[0];
    if (event?.type !== GlyphHostEventType.QUESTION) throw new Error('Question was not published');
    expect(() =>
      broker.answer({ chatId: 'chat', runId: 'run', id: event.question.id, kind: 'question', value: {} }),
    ).toThrow('no longer pending');
  });

  it('grants a shell approval only once without upgrading it to permanent or unrestricted access', async () => {
    const events: GlyphHostEvent[] = [];
    const broker = new DesktopInteractionBroker(event => events.push(event));
    const result = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.presentShellPermission({ command: 'test', workingDirectory: '/project' }, new AbortController().signal),
    );
    const event = events[0];
    if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Approval was not published');
    broker.answer({ chatId: 'chat', runId: 'run', id: event.approval.id, kind: 'approval', value: true });
    await expect(result).resolves.toBe(ShellPermissionDecision.ALLOW_ONCE);
  });
});
