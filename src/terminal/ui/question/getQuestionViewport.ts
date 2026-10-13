import wrapAnsi from 'wrap-ansi';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';
import type { QuestionFormState } from './useQuestionFormState.ts';

/** Keeps keyboard paging and rendered clipping on the same hard-wrap geometry. */
export function getQuestionViewport(input: QuestionFormState & { rows: number; columns: number }): {
  height: number;
  offset: number;
  focusOffset: number;
  maximumOffset: number;
  focusVisible: boolean;
} {
  const lineCount = (text: string) =>
    wrapAnsi(sanitizeText(text), Math.max(1, input.columns - 4), {
      hard: true,
      trim: false,
      wordWrap: false,
    }).split('\n').length;
  const headerRows =
    lineCount(`${input.title ?? 'Question'}  ${input.questionNumber}/${input.questionCount}`) +
    lineCount(input.question.prompt);
  const optionRows = input.question.options.map(option => lineCount(`› ● ${option.label}`));
  const rowsBefore = headerRows + optionRows.slice(0, input.highlightedOption).reduce((sum, count) => sum + count, 0);
  let focusEnd = rowsBefore + (optionRows[input.highlightedOption] ?? 1);
  if (input.enteringOther) focusEnd += lineCount(`other> ${input.otherText.slice(0, input.otherCursor)} `);
  const totalRows =
    headerRows +
    optionRows.reduce((sum, count) => sum + count, 0) +
    1 +
    (input.enteringOther ? lineCount(`other> ${input.otherText} `) : 0);
  const height = Math.min(totalRows, Math.max(1, input.rows - 5 - Number(Boolean(input.diagnostic))));
  const maximumOffset = Math.max(0, totalRows - height);
  const focusRow = input.enteringOther ? focusEnd - 1 : rowsBefore;
  const focusOffset = Math.min(maximumOffset, focusRow, Math.max(0, focusEnd - height));
  const offset = Math.min(maximumOffset, Math.max(0, input.scrollOffset ?? focusOffset));
  return { height, maximumOffset, focusOffset, offset, focusVisible: focusRow >= offset && focusRow < offset + height };
}
