import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { fn } from 'storybook/test';
import { isolateComposer } from '#code-oss/storybook/decorators.tsx';
import { userMessageFixture, agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import {
  languageQuestion,
  preferencesQuestion,
  followUpQuestion,
} from '#code-oss/storybook/fixtures/InteractionFixtures.ts';
import { runFixture } from '#code-oss/storybook/fixtures/ToolFixtures.ts';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { useState } from 'preact/hooks';
import { questionAnswersSchema } from '#src/interaction/questions/questionAnswersSchema.js';
import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphWorkbench } from './GlyphWorkbench.wired.tsx';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { workbenchStateFixture } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';

const run = runFixture({ reasoning: 'A few details will help me continue.' });
const question = languageQuestion;
const transcript = [
  userMessageFixture({ id: 'user', text: 'Help me choose a language for this project.' }),
  agentMessageFixture({ id: 'run', text: 'I have a couple of questions before we start.' }),
];
const questions = workbenchStateFixture({
  selectedChatId: 'chat',
  status: GlyphWorkbenchStatus.WAITING_FOR_QUESTION,
  transcript,
  runs: [{ ...run, status: GlyphRunStatus.WAITING_FOR_QUESTION, question }],
});
const meta = {
  title: 'Glyph/Chat/In Transcript/Questions',
  component: WiredGlyphWorkbench,
  args: { state: questions, actions: previewActionsFixture() },
  decorators: [isolateComposer],
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof WiredGlyphWorkbench>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Questions: Story = {};

export const ReadOnly: Story = { args: { state: { ...questions, readOnly: true } } };
export const SubmissionFailure: Story = {
  args: {
    actions: {
      ...previewActionsFixture(),
      answerQuestion: fn<NonNullable<GlyphWorkbenchViewActions['answerQuestion']>>(async () => {
        throw new Error('The connection was interrupted. Your answers are still here; try again.');
      }).mockName('GlyphInteractions.answerQuestion'),
    },
  },
};

const questionnaire = preferencesQuestion;
function QuestionnairePreview({ consecutive = false }: { readonly consecutive?: boolean }) {
  const [responses, setResponses] = useState<readonly GlyphQuestionResponse[]>([]);
  const [round, setRound] = useState(0);
  const waiting = round < (consecutive ? 2 : 1);
  const request = round === 0 ? questionnaire : followUpQuestion;
  return (
    <WiredGlyphWorkbench
      state={workbenchStateFixture({
        selectedChatId: 'chat',
        status: waiting ? GlyphWorkbenchStatus.WAITING_FOR_QUESTION : GlyphWorkbenchStatus.READY,
        transcript: [
          userMessageFixture({ id: 'user', text: 'Ask me about my editor and testing preferences.' }),
          agentMessageFixture({
            id: 'run',
            text: waiting ? '' : 'Thanks, I have your preferences.',
            questionResponses: responses,
          }),
        ],
        runs: [
          {
            ...run,
            status: waiting ? GlyphRunStatus.WAITING_FOR_QUESTION : GlyphRunStatus.COMPLETED,
            ...(waiting ? { question: request } : {}),
          },
        ],
      })}
      actions={{
        ...previewActionsFixture(),
        answerQuestion: fn<NonNullable<GlyphWorkbenchViewActions['answerQuestion']>>(
          async (_chat, _run, _id, value) => {
            const result = questionAnswersSchema.parse(value);
            setResponses([
              ...responses,
              {
                id: request.id,
                answers: request.questions.map(asked => {
                  const answer = result.answers.find(answer => answer.questionId === asked.id)!;
                  return {
                    question: asked.prompt,
                    answer:
                      answer.type === QuestionAnswerType.OTHER
                        ? answer.text
                        : asked.options
                            .filter(option => answer.optionIds.includes(option.id))
                            .map(option => option.label)
                            .join(', '),
                  };
                }),
              },
            ]);
            setRound(round + 1);
          },
        ).mockName('GlyphInteractions.answerQuestion'),
      }}
    />
  );
}
export const MultiSelectSequence: Story = { render: () => <QuestionnairePreview /> };
export const ConsecutiveForms: Story = { render: () => <QuestionnairePreview consecutive /> };
export const SubmittedAnswers: Story = {
  args: {
    state: workbenchStateFixture({
      transcript: [
        agentMessageFixture({
          id: 'answers',
          text: '',
          questionResponses: [
            {
              id: 'preferences',
              answers: [
                { question: questionnaire.questions[0]!.prompt, answer: 'High contrast' },
                { question: questionnaire.questions[1]!.prompt, answer: 'Vitest, Jest, node:test' },
                { question: questionnaire.questions[2]!.prompt, answer: 'Coffee' },
              ],
            },
          ],
        }),
      ],
    }),
  },
};
