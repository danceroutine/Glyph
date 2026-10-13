import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { PromptLayout } from './PromptLayout.ts';

/** Shares hard-wrap geometry between the clipped composer and the terminal caret. */
export function getPromptViewport(input: {
  readonly text: string;
  readonly prefix: string;
  readonly columns: number;
  readonly rows: number;
  readonly overhead: number;
}): { height: number; offset: number; cursorX: number; cursorY: number } {
  const width = Math.max(1, input.columns - PromptLayout.railHorizontalPadding * 2);
  const wrap = (text: string) => wrapAnsi(text, width, { hard: true, trim: false, wordWrap: false }).split('\n');
  const prefix = wrap(input.prefix);
  const lastWidth = stringWidth(prefix.at(-1) ?? '');
  const cursorRow = prefix.length - 1 + Math.floor(lastWidth / width);
  const budget = Math.max(1, Math.min(6, Math.floor(input.rows / 2) - input.overhead));
  // The trailing space reserves the caret cell after an exactly full row.
  const height = Math.min(budget, Math.max(cursorRow + 1, wrap(`${input.text} `).length));
  const offset = Math.max(0, cursorRow - height + 1);
  return { height, offset, cursorX: lastWidth % width, cursorY: cursorRow - offset };
}
