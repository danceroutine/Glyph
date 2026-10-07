import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { sanitizeText } from '../shared/sanitizeText.ts';
import type { QuestionFormState } from './useQuestionFormState.ts';

export type QuestionFormProps = QuestionFormState;

export function QuestionForm({
  title,
  question,
  questionNumber,
  questionCount,
  highlightedOption,
  selectedOptionIds,
  enteringOther,
  otherText,
  otherCursor,
  diagnostic,
}: QuestionFormProps): ReactElement {
  return (
    <Box
      backgroundColor="#20242c"
      borderColor="cyan"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      width="100%"
    >
      <Text>
        <Text bold color="cyan">
          {sanitizeText(title ?? 'Question')}
        </Text>
        <Text dimColor>{`  ${questionNumber}/${questionCount}`}</Text>
      </Text>
      <Text bold>{sanitizeText(question.prompt)}</Text>
      {question.options.map((option, index) => {
        const highlighted = index === highlightedOption;
        const selected = selectedOptionIds.includes(option.id);
        return (
          <Text key={option.id} {...(highlighted ? { color: 'cyan' as const } : {})}>
            {highlighted ? '› ' : '  '}
            {question.allowMultiple ? (selected ? '☑ ' : '☐ ') : highlighted ? '● ' : '○ '}
            {sanitizeText(option.label)}
          </Text>
        );
      })}
      <Text {...(highlightedOption === question.options.length ? { color: 'cyan' as const } : {})}>
        {highlightedOption === question.options.length ? '› ' : '  '}
        {'… Other'}
      </Text>
      {enteringOther ? <OtherAnswerEditor text={otherText} cursor={otherCursor} /> : null}
      {diagnostic ? <Text color="yellow">{sanitizeText(diagnostic)}</Text> : null}
      <Text dimColor>
        {enteringOther
          ? 'Enter confirm  Esc choices  Ctrl+C cancel'
          : question.allowMultiple
            ? '↑/↓ move  Space toggle  Enter confirm  Ctrl+C cancel'
            : '↑/↓ move  Enter select  Ctrl+C cancel'}
      </Text>
    </Box>
  );
}

function OtherAnswerEditor({ text, cursor }: { text: string; cursor: number }): ReactElement {
  const current = text.slice(cursor, cursor + 1);
  return (
    <Text>
      <Text bold color="cyan">
        {'other> '}
      </Text>
      {sanitizeText(text.slice(0, cursor))}
      <Text inverse>{sanitizeText(current || ' ')}</Text>
      {sanitizeText(text.slice(cursor + current.length))}
    </Text>
  );
}
