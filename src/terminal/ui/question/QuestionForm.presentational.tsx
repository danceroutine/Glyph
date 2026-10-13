import type { ReactElement } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';
import type { QuestionFormState } from './useQuestionFormState.ts';
import { getQuestionViewport } from './getQuestionViewport.ts';

export type QuestionFormProps = QuestionFormState;

export function QuestionForm(props: QuestionFormProps): ReactElement {
  const {
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
  } = props;
  const { height, offset } = getQuestionViewport({ ...props, ...useWindowSize() });
  return (
    <Box
      backgroundColor="#20242c"
      borderColor="cyan"
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="column" flexShrink={0} height={height} overflow="hidden" contentOffsetY={offset}>
        <Box flexDirection="column" flexShrink={0} width="100%">
          <Text wrap="hard">
            <Text bold color="cyan">
              {sanitizeText(title ?? 'Question')}
            </Text>
            <Text dimColor>{`  ${questionNumber}/${questionCount}`}</Text>
          </Text>
          <Text bold wrap="hard">
            {sanitizeText(question.prompt)}
          </Text>
          {question.options.map((option, index) => {
            const highlighted = index === highlightedOption;
            const selected = selectedOptionIds.includes(option.id);
            return (
              <Text key={option.id} wrap="hard" {...(highlighted ? { color: 'cyan' as const } : {})}>
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
        </Box>
      </Box>
      {diagnostic ? (
        <Text color="yellow" wrap="truncate">
          {sanitizeText(diagnostic)}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate">
        {enteringOther
          ? 'Enter confirm  Esc choices  Ctrl+C cancel'
          : question.allowMultiple
            ? '↑/↓ move  Space toggle  Enter confirm  Ctrl+C cancel'
            : '↑/↓ move  Enter select  Ctrl+C cancel'}
        {'  PgUp/PgDn scroll'}
      </Text>
    </Box>
  );
}

function OtherAnswerEditor({ text, cursor }: { text: string; cursor: number }): ReactElement {
  const current = text.slice(cursor, cursor + 1);
  return (
    <Text wrap="hard">
      <Text bold color="cyan">
        {'other> '}
      </Text>
      {sanitizeText(text.slice(0, cursor))}
      <Text inverse>{sanitizeText(current || ' ')}</Text>
      {sanitizeText(text.slice(cursor + current.length))}
    </Text>
  );
}
