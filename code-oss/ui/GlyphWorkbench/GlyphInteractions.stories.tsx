import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { useState } from 'preact/hooks';
import type { QuestionFormResult } from '#src/interaction/questions/QuestionFormResult.js';
import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphWorkbench } from './GlyphWorkbench.wired.tsx';
import { previewActions, workbenchState } from '#code-oss/storybook/fixtures.ts';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

const run = { chatId: 'chat', runId: 'run', text: '', reasoning: 'A few details will help me continue.', tools: [] };
const question = {
  id: 'question',
  title: 'Questions',
  prompt: 'Choose a language.',
  questions: [
    {
      id: 'language',
      prompt: 'What is your favorite programming language?',
      allowMultiple: false,
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'rust', label: 'Rust' },
        { id: 'python', label: 'Python' },
      ],
    },
    {
      id: 'priorities',
      prompt: 'Which qualities matter most?',
      allowMultiple: true,
      options: [
        { id: 'clarity', label: 'Clarity' },
        { id: 'speed', label: 'Speed' },
      ],
    },
  ],
};
const transcript = [
  { id: 'user', role: GlyphTranscriptRole.USER, text: 'Help me choose a language for this project.' },
  { id: 'run', role: GlyphTranscriptRole.ASSISTANT, text: 'I have a couple of questions before we start.' },
];
const questions = workbenchState({
  selectedChatId: 'chat',
  status: GlyphWorkbenchStatus.WAITING_FOR_QUESTION,
  transcript,
  runs: [{ ...run, status: GlyphRunStatus.WAITING_FOR_QUESTION, question }],
});
const meta = {
  title: 'Glyph/Chat/Interactions',
  component: WiredGlyphWorkbench,
  args: { state: questions, actions: previewActions },
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof WiredGlyphWorkbench>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Questions: Story = {};
export const Approval: Story = {
  args: {
    state: workbenchState({
      selectedChatId: 'chat',
      status: GlyphWorkbenchStatus.WAITING_FOR_APPROVAL,
      transcript: [{ id: 'run', role: GlyphTranscriptRole.ASSISTANT, text: 'I’ll run the project tests.' }],
      runs: [
        {
          ...run,
          status: GlyphRunStatus.WAITING_FOR_APPROVAL,
          approval: {
            id: 'approval',
            title: 'Allow shell command?',
            detail: 'pnpm test',
            command: 'pnpm test',
            workingDirectory: '/workspace/glyph',
            sandboxed: true,
            canRemember: true,
          },
        },
      ],
    }),
  },
};
export const ReadOnly: Story = { args: { state: { ...questions, readOnly: true } } };
export const SubmissionFailure: Story = {
  args: {
    actions: {
      ...previewActions,
      answerQuestion: async () => {
        throw new Error('The connection was interrupted. Your answers are still here; try again.');
      },
    },
  },
};

const questionnaire = {
  id: 'preferences',
  title: 'Questions',
  prompt: 'A few preferences.',
  questions: [
    {
      id: 'theme',
      prompt: 'Which editor theme do you usually use?',
      allowMultiple: false,
      options: [
        { id: 'dark', label: 'Dark (Recommended)' },
        { id: 'light', label: 'Light' },
        { id: 'contrast', label: 'High contrast' },
        { id: 'system', label: 'Follow the system setting' },
      ],
    },
    {
      id: 'runners',
      prompt: 'Which test runners have you used? Pick as many as apply.',
      allowMultiple: true,
      options: [
        { id: 'vitest', label: 'Vitest' },
        { id: 'jest', label: 'Jest' },
        { id: 'node', label: 'node:test' },
        { id: 'playwright', label: 'Playwright' },
      ],
    },
    {
      id: 'drink',
      prompt: 'Coffee or tea?',
      allowMultiple: false,
      options: [
        { id: 'coffee', label: 'Coffee' },
        { id: 'tea', label: 'Tea' },
      ],
    },
  ],
};
function QuestionnairePreview({ consecutive = false }: { readonly consecutive?: boolean }) {
  const [responses, setResponses] = useState<readonly GlyphQuestionResponse[]>([]);
  const [round, setRound] = useState(0);
  const waiting = round < (consecutive ? 2 : 1);
  const request =
    round === 0
      ? questionnaire
      : {
          ...questionnaire,
          id: 'follow-up',
          questions: [
            {
              id: 'follow-up',
              prompt: 'One follow-up: should I include examples?',
              allowMultiple: false,
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No' },
              ],
            },
          ],
        };
  return (
    <WiredGlyphWorkbench
      state={workbenchState({
        selectedChatId: 'chat',
        status: waiting ? GlyphWorkbenchStatus.WAITING_FOR_QUESTION : GlyphWorkbenchStatus.READY,
        transcript: [
          { id: 'user', role: GlyphTranscriptRole.USER, text: 'Ask me about my editor and testing preferences.' },
          {
            id: 'run',
            role: GlyphTranscriptRole.ASSISTANT,
            text: waiting ? '' : 'Thanks, I have your preferences.',
            questionResponses: responses,
          },
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
        ...previewActions,
        answerQuestion: async (_chat, _run, _id, value) => {
          const result = value as QuestionFormResult;
          setResponses([
            ...responses,
            {
              id: request.id,
              answers: request.questions.map(question => {
                const answer = result.answers.find(answer => answer.questionId === question.id)!;
                return {
                  question: question.prompt,
                  answer:
                    answer.type === QuestionAnswerType.OTHER
                      ? answer.text
                      : question.options
                          .filter(option => answer.optionIds.includes(option.id))
                          .map(option => option.label)
                          .join(', '),
                };
              }),
            },
          ]);
          setRound(round + 1);
        },
      }}
    />
  );
}
export const MultiSelectSequence: Story = { render: () => <QuestionnairePreview /> };
export const ConsecutiveForms: Story = { render: () => <QuestionnairePreview consecutive /> };
export const SubmittedAnswers: Story = {
  args: {
    state: workbenchState({
      transcript: [
        {
          id: 'answers',
          role: GlyphTranscriptRole.ASSISTANT,
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
        },
      ],
    }),
  },
};
