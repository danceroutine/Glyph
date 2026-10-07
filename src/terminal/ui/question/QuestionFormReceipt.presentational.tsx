import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { QuestionAnswerType } from '../../../interaction/questions/QuestionAnswerType.ts';
import type { QuestionForm } from '../../../interaction/questions/QuestionForm.ts';
import type { QuestionFormResult } from '../../../interaction/questions/QuestionFormResult.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';

export interface QuestionFormReceiptProps {
  readonly form: QuestionForm;
  readonly result: QuestionFormResult;
}

export function QuestionFormReceipt({ form, result }: QuestionFormReceiptProps): ReactElement {
  const answers = new Map(result.answers.map(answer => [answer.questionId, answer]));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        {sanitizeText(form.title ?? 'Answered questions')}
      </Text>
      {form.questions.map(question => {
        const answer = answers.get(question.id)!;
        const value =
          answer.type === QuestionAnswerType.OTHER
            ? answer.text
            : answer.optionIds
                .map(optionId => question.options.find(option => option.id === optionId)!.label)
                .join(', ');
        return (
          <Text key={question.id}>
            <Text dimColor>{`${sanitizeText(question.prompt)}  `}</Text>
            {sanitizeText(value)}
          </Text>
        );
      })}
    </Box>
  );
}
