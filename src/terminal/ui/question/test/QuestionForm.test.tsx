import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { QuestionForm } from '#src/terminal/ui/question/QuestionForm.presentational.js';
import { QuestionFormReceipt } from '#src/terminal/ui/question/QuestionFormReceipt.presentational.js';

const singleQuestion = {
  id: 'color',
  prompt: 'Choose a color.',
  options: [
    { id: 'red', label: 'Red' },
    { id: 'blue', label: 'Blue' },
  ],
  allowMultiple: false,
} as const;

describe(QuestionForm, () => {
  it('renders an entire emoji under the freeform cursor without splitting its UTF-16 surrogate pair', async () => {
    // Ink styles each Text node separately. Exercise real ANSI output even in
    // non-TTY CI, where disabled colors would conceal split surrogate halves.
    const { default: chalk } = (await import(createRequire(import.meta.resolve('ink')).resolve('chalk'))) as {
      default: { level: number };
    };
    const previousLevel = chalk.level;
    chalk.level = 1;
    const view = render(
      <QuestionForm
        title={undefined}
        question={singleQuestion}
        questionNumber={1}
        questionCount={1}
        highlightedOption={2}
        selectedOptionIds={[]}
        enteringOther
        otherText="😀 answer"
        otherCursor={0}
        diagnostic=""
      />,
    );
    try {
      const encoded = Buffer.from(view.lastFrame() ?? '', 'utf8').toString('utf8');
      expect(encoded).toContain('\u001B[7m😀');
      expect(stripVTControlCharacters(encoded)).toContain('other> 😀 answer');
      expect(encoded).not.toContain('\uFFFD');
    } finally {
      view.unmount();
      chalk.level = previousLevel;
    }
  });
  describe('rendering', () => {
    it('renders a default title, single-choice state, an Other editor, and a diagnostic', () => {
      const view = render(
        <QuestionForm
          title={undefined}
          question={singleQuestion}
          questionNumber={1}
          questionCount={2}
          highlightedOption={2}
          selectedOptionIds={[]}
          enteringOther
          otherText={'cu\u001Bstom'}
          otherCursor={2}
          diagnostic={'Try\u0000 again'}
        />,
      );

      expect(view.lastFrame()).toContain('Question  1/2');
      expect(view.lastFrame()).toContain('○ Red');
      expect(view.lastFrame()).toContain('› … Other');
      expect(view.lastFrame()).toContain('other> custom');
      expect(view.lastFrame()).toContain('Try again');
      expect(view.lastFrame()).toContain('Esc choices');
      view.unmount();
    });

    it('renders selected multiple choices and their keyboard help', () => {
      const view = render(
        <QuestionForm
          title="Feature set"
          question={{ ...singleQuestion, allowMultiple: true }}
          questionNumber={2}
          questionCount={2}
          highlightedOption={0}
          selectedOptionIds={['red']}
          enteringOther={false}
          otherText=""
          otherCursor={0}
          diagnostic=""
        />,
      );

      expect(view.lastFrame()).toContain('Feature set  2/2');
      expect(view.lastFrame()).toContain('› ☑ Red');
      expect(view.lastFrame()).toContain('☐ Blue');
      expect(view.lastFrame()).toContain('Space toggle');
      view.unmount();
    });

    it('renders the single-choice help when no Other editor is active', () => {
      const view = render(
        <QuestionForm
          title="Color"
          question={singleQuestion}
          questionNumber={1}
          questionCount={1}
          highlightedOption={0}
          selectedOptionIds={[]}
          enteringOther={false}
          otherText=""
          otherCursor={0}
          diagnostic=""
        />,
      );

      expect(view.lastFrame()).toContain('› ● Red');
      expect(view.lastFrame()).toContain('Enter select');
      view.unmount();
    });
  });
});

describe(QuestionFormReceipt, () => {
  describe('rendering', () => {
    it('renders option labels and free text rather than internal identifiers', () => {
      const view = render(
        <QuestionFormReceipt
          form={{
            title: 'Decisions',
            questions: [singleQuestion, { ...singleQuestion, id: 'name', prompt: 'Name it.' }],
          }}
          result={{
            answers: [
              { questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red', 'blue'] },
              { questionId: 'name', type: QuestionAnswerType.OTHER, text: 'Violet' },
            ],
          }}
        />,
      );

      expect(view.lastFrame()).toContain('Decisions');
      expect(view.lastFrame()).toContain('Choose a color.  Red, Blue');
      expect(view.lastFrame()).toContain('Name it.  Violet');
      view.unmount();
    });

    it('uses the default receipt title', () => {
      const view = render(
        <QuestionFormReceipt
          form={{ questions: [singleQuestion] }}
          result={{
            answers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }],
          }}
        />,
      );

      expect(view.lastFrame()).toContain('Answered questions');
      view.unmount();
    });
  });
});
