import { describe, expect, it, vi } from 'vitest';
import type { QuestionAnswer } from '../QuestionAnswer.ts';
import { QuestionAnswerType } from '../QuestionAnswerType.ts';
import type { QuestionPresenter } from '../QuestionPresenter.ts';
import { ProposeQuestionToolRuntime } from '../ProposeQuestionToolRuntime.ts';
import { QuestionToolName } from '../QuestionToolName.ts';
import { QuestionToolNamespace } from '../QuestionToolNamespace.ts';

const validInput = JSON.stringify({
  title: 'Choose an implementation',
  questions: [
    {
      id: 'storage',
      prompt: 'Which storage should we use?',
      options: [
        { id: 'sqlite', label: 'SQLite' },
        { id: 'files', label: 'JSON files' },
      ],
      allow_multiple: null,
    },
    {
      id: 'features',
      prompt: 'Which optional features should be included?',
      options: [
        { id: 'search', label: 'Search' },
        { id: 'export', label: 'Export' },
      ],
      allow_multiple: true,
    },
    {
      id: 'name',
      prompt: 'Which name should we use?',
      options: [
        { id: 'glyph', label: 'Glyph' },
        { id: 'harness', label: 'Harness' },
      ],
      allow_multiple: false,
    },
  ],
});

describe(ProposeQuestionToolRuntime, () => {
  describe('definitions', () => {
    it('exposes a provider-neutral strict JSON tool in the interaction namespace', () => {
      const runtime = new ProposeQuestionToolRuntime(presenter(async () => ({ answers: [] })));

      expect(runtime.definitions).toEqual([
        expect.objectContaining({
          namespace: QuestionToolNamespace.INTERACTION,
          name: QuestionToolName.PROPOSE_QUESTION,
          inputKind: 'JSON',
          parameters: expect.objectContaining({
            type: 'object',
            required: ['title', 'questions'],
            additionalProperties: false,
          }),
        }),
      ]);
    });
  });

  describe(ProposeQuestionToolRuntime.prototype.execute, () => {
    it('normalizes the form and serializes single, multiple, and Other answers', async () => {
      const present = vi.fn<QuestionPresenter['present']>(async () => ({
        answers: [
          { questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['sqlite'] },
          { questionId: 'features', type: QuestionAnswerType.SELECTION, optionIds: ['search', 'search', 'export'] },
          { questionId: 'name', type: QuestionAnswerType.OTHER, text: '  Engraver  ' },
        ],
      }));
      const runtime = new ProposeQuestionToolRuntime({ present });
      const signal = new AbortController().signal;

      await expect(runtime.execute(QuestionToolName.PROPOSE_QUESTION, validInput, signal)).resolves.toBe(
        JSON.stringify({
          answers: { storage: 'sqlite', features: ['search', 'export'], name: 'Engraver' },
        }),
      );
      expect(present).toHaveBeenCalledWith(
        {
          title: 'Choose an implementation',
          questions: [
            expect.objectContaining({ id: 'storage', allowMultiple: false }),
            expect.objectContaining({ id: 'features', allowMultiple: true }),
            expect.objectContaining({ id: 'name', allowMultiple: false }),
          ],
        },
        signal,
      );
    });

    it('accepts omitted optional fields while exposing a strict nullable provider schema', async () => {
      const present = vi.fn<QuestionPresenter['present']>(async form => ({
        answers: [{ questionId: form.questions[0]!.id, type: QuestionAnswerType.SELECTION, optionIds: ['yes'] }],
      }));
      const runtime = new ProposeQuestionToolRuntime({ present });

      await runtime.execute(
        QuestionToolName.PROPOSE_QUESTION,
        JSON.stringify({
          questions: [
            {
              id: 'confirm',
              prompt: 'Continue?',
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No' },
              ],
            },
          ],
        }),
      );

      expect(present.mock.calls[0]?.[0]).toEqual({
        questions: [expect.objectContaining({ id: 'confirm', allowMultiple: false })],
      });
    });

    it('safely preserves arbitrary string identifiers as answer keys', async () => {
      const runtime = new ProposeQuestionToolRuntime(
        presenter(async () => ({
          answers: [{ questionId: '__proto__', type: QuestionAnswerType.SELECTION, optionIds: ['option.one'] }],
        })),
      );

      const output = await runtime.execute(
        QuestionToolName.PROPOSE_QUESTION,
        JSON.stringify({
          questions: [
            {
              id: '__proto__',
              prompt: 'Choose.',
              options: [
                { id: 'option.one', label: 'One' },
                { id: 'option.two', label: 'Two' },
              ],
            },
          ],
        }),
      );

      expect(JSON.parse(output)).toEqual(JSON.parse('{"answers":{"__proto__":"option.one"}}'));
    });

    it.each([
      ['invalid JSON', '{'],
      [
        'duplicate question identifiers',
        JSON.stringify({
          title: null,
          questions: [question('same'), question('same')],
        }),
      ],
      [
        'duplicate option identifiers',
        JSON.stringify({
          title: null,
          questions: [
            {
              ...question('one'),
              options: [
                { id: 'same', label: 'First' },
                { id: 'same', label: 'Second' },
              ],
            },
          ],
        }),
      ],
    ])('returns a malformed result for %s', async (_case, input) => {
      const present = vi.fn<QuestionPresenter['present']>();
      const runtime = new ProposeQuestionToolRuntime({ present });

      const result = JSON.parse(await runtime.execute(QuestionToolName.PROPOSE_QUESTION, input)) as {
        error: { code: string };
      };

      expect(result.error.code).toBe('MALFORMED');
      expect(present).not.toHaveBeenCalled();
    });

    it.each<[string, readonly QuestionAnswer[], string]>([
      [
        'duplicate answers',
        [
          { questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['sqlite'] },
          { questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['files'] },
        ],
        'duplicate answers',
      ],
      ['missing answers', [], 'did not answer storage'],
      [
        'empty Other answers',
        [{ questionId: 'storage', type: QuestionAnswerType.OTHER, text: '  ' }],
        'Other answer for storage is empty',
      ],
      [
        'empty selections',
        [{ questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: [] }],
        'selected no option',
      ],
      [
        'multiple selections for a single-choice question',
        [{ questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['sqlite', 'files'] }],
        'selected multiple options',
      ],
      [
        'unknown selections',
        [{ questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['postgres'] }],
        'selected an unknown option',
      ],
    ])('rejects presenter results containing %s', async (_case, answers, message) => {
      const runtime = new ProposeQuestionToolRuntime(presenter(async () => ({ answers })));
      const input = singleQuestionInput();

      const result = JSON.parse(await runtime.execute(QuestionToolName.PROPOSE_QUESTION, input)) as {
        error: { code: string; message: string };
      };

      expect(result.error).toEqual({ code: 'QUESTION_FAILED', message: expect.stringContaining(message) });
    });

    it('rejects presenter results containing an unknown answer', async () => {
      const runtime = new ProposeQuestionToolRuntime(
        presenter(async () => ({
          answers: [
            { questionId: 'storage', type: QuestionAnswerType.SELECTION, optionIds: ['sqlite'] },
            { questionId: 'extra', type: QuestionAnswerType.OTHER, text: 'surprise' },
          ],
        })),
      );

      const result = JSON.parse(await runtime.execute(QuestionToolName.PROPOSE_QUESTION, singleQuestionInput())) as {
        error: { message: string };
      };

      expect(result.error.message).toContain('unknown answer');
    });

    it('reports presenter failures and preserves non-Error failures', async () => {
      const failed = new ProposeQuestionToolRuntime(presenter(async () => Promise.reject(new Error('screen failed'))));
      const unknown = new ProposeQuestionToolRuntime(presenter(async () => Promise.reject('broken')));

      await expect(failed.execute(QuestionToolName.PROPOSE_QUESTION, singleQuestionInput())).resolves.toContain(
        'screen failed',
      );
      await expect(unknown.execute(QuestionToolName.PROPOSE_QUESTION, singleQuestionInput())).resolves.toContain(
        'Question presentation failed.',
      );
    });

    it('propagates cancellation instead of turning it into a tool result', async () => {
      const controller = new AbortController();
      const runtime = new ProposeQuestionToolRuntime(
        presenter(async () => {
          controller.abort(new Error('cancelled'));
          throw new Error('presenter stopped');
        }),
      );

      await expect(
        runtime.execute(QuestionToolName.PROPOSE_QUESTION, singleQuestionInput(), controller.signal),
      ).rejects.toThrow('cancelled');
    });

    it('rejects unknown interaction tools before invoking the presenter', async () => {
      const present = vi.fn<QuestionPresenter['present']>();
      const runtime = new ProposeQuestionToolRuntime({ present });

      await expect(runtime.execute('not_a_tool', '{}')).rejects.toThrow('Unknown interaction tool');
      expect(present).not.toHaveBeenCalled();
    });
  });
});

function presenter(present: QuestionPresenter['present']): QuestionPresenter {
  return { present };
}

function question(id: string) {
  return {
    id,
    prompt: 'Choose one.',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
    allow_multiple: null,
  };
}

function singleQuestionInput(): string {
  return JSON.stringify({
    title: null,
    questions: [
      {
        id: 'storage',
        prompt: 'Which storage?',
        options: [
          { id: 'sqlite', label: 'SQLite' },
          { id: 'files', label: 'Files' },
        ],
        allow_multiple: null,
      },
    ],
  });
}
