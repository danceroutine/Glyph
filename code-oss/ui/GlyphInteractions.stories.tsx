import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbench } from './GlyphWorkbench.tsx';
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
  title: 'Glyph/Interactions',
  component: GlyphWorkbench,
  args: { state: questions, actions: previewActions },
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof GlyphWorkbench>;
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
