import type { Key } from 'ink';

export enum PromptEditAction {
  MOVE_CHARACTER_BACKWARD = 'MOVE_CHARACTER_BACKWARD',
  MOVE_CHARACTER_FORWARD = 'MOVE_CHARACTER_FORWARD',
  MOVE_WORD_BACKWARD = 'MOVE_WORD_BACKWARD',
  MOVE_WORD_FORWARD = 'MOVE_WORD_FORWARD',
  MOVE_LINE_BACKWARD = 'MOVE_LINE_BACKWARD',
  MOVE_LINE_FORWARD = 'MOVE_LINE_FORWARD',
  DELETE_CHARACTER_BACKWARD = 'DELETE_CHARACTER_BACKWARD',
  DELETE_CHARACTER_FORWARD = 'DELETE_CHARACTER_FORWARD',
  DELETE_WORD_BACKWARD = 'DELETE_WORD_BACKWARD',
  DELETE_WORD_FORWARD = 'DELETE_WORD_FORWARD',
  DELETE_LINE_BACKWARD = 'DELETE_LINE_BACKWARD',
  DELETE_LINE_FORWARD = 'DELETE_LINE_FORWARD',
}

export interface PromptEditResult {
  readonly text: string;
  readonly cursor: number;
}

type EditingKey = Pick<
  Key,
  | 'backspace'
  | 'ctrl'
  | 'delete'
  | 'end'
  | 'eventType'
  | 'home'
  | 'leftArrow'
  | 'meta'
  | 'rightArrow'
  | 'super'
  | 'upArrow'
  | 'downArrow'
>;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

export function editPrompt(input: string, key: EditingKey, text: string, cursor: number): PromptEditResult | undefined {
  const action = promptEditAction(input, key);
  if (!action) return undefined;
  switch (action) {
    case PromptEditAction.MOVE_CHARACTER_BACKWARD:
      return { text, cursor: previousCharacterOffset(text, cursor) };
    case PromptEditAction.MOVE_CHARACTER_FORWARD:
      return { text, cursor: nextCharacterOffset(text, cursor) };
    case PromptEditAction.MOVE_WORD_BACKWARD:
      return { text, cursor: previousWordOffset(text, cursor) };
    case PromptEditAction.MOVE_WORD_FORWARD:
      return { text, cursor: nextWordOffset(text, cursor) };
    case PromptEditAction.MOVE_LINE_BACKWARD:
      return { text, cursor: 0 };
    case PromptEditAction.MOVE_LINE_FORWARD:
      return { text, cursor: text.length };
    case PromptEditAction.DELETE_CHARACTER_BACKWARD:
      return deleteRange(text, previousCharacterOffset(text, cursor), cursor);
    case PromptEditAction.DELETE_CHARACTER_FORWARD:
      return deleteRange(text, cursor, nextCharacterOffset(text, cursor));
    case PromptEditAction.DELETE_WORD_BACKWARD:
      return deleteRange(text, previousWordOffset(text, cursor), cursor);
    case PromptEditAction.DELETE_WORD_FORWARD:
      return deleteRange(text, cursor, nextWordOffset(text, cursor));
    case PromptEditAction.DELETE_LINE_BACKWARD:
      return deleteRange(text, 0, cursor);
    case PromptEditAction.DELETE_LINE_FORWARD:
      return deleteRange(text, cursor, text.length);
  }
}

export function promptEditAction(input: string, key: EditingKey): PromptEditAction | undefined {
  if (key.eventType === 'release') return undefined;
  const character = input.toLowerCase();

  if (key.super && key.backspace) return PromptEditAction.DELETE_LINE_BACKWARD;
  if (key.super && key.delete) return PromptEditAction.DELETE_LINE_FORWARD;
  if (key.ctrl && character === 'u') return PromptEditAction.DELETE_LINE_BACKWARD;
  if (key.ctrl && character === 'k') return PromptEditAction.DELETE_LINE_FORWARD;

  if ((key.meta || key.ctrl) && key.backspace) return PromptEditAction.DELETE_WORD_BACKWARD;
  if ((key.meta || key.ctrl) && key.delete) return PromptEditAction.DELETE_WORD_FORWARD;
  if (key.ctrl && character === 'w') return PromptEditAction.DELETE_WORD_BACKWARD;
  if (key.meta && character === 'd') return PromptEditAction.DELETE_WORD_FORWARD;

  if ((key.super && (key.leftArrow || key.upArrow)) || (key.meta && key.upArrow)) {
    return PromptEditAction.MOVE_LINE_BACKWARD;
  }
  if ((key.super && (key.rightArrow || key.downArrow)) || (key.meta && key.downArrow)) {
    return PromptEditAction.MOVE_LINE_FORWARD;
  }
  if (key.home || (key.ctrl && character === 'a')) return PromptEditAction.MOVE_LINE_BACKWARD;
  if (key.end || (key.ctrl && character === 'e')) return PromptEditAction.MOVE_LINE_FORWARD;

  if ((key.ctrl || key.meta) && key.leftArrow) return PromptEditAction.MOVE_WORD_BACKWARD;
  if ((key.ctrl || key.meta) && key.rightArrow) return PromptEditAction.MOVE_WORD_FORWARD;
  if (key.meta && character === 'b') return PromptEditAction.MOVE_WORD_BACKWARD;
  if (key.meta && character === 'f') return PromptEditAction.MOVE_WORD_FORWARD;

  if (key.leftArrow || (key.ctrl && character === 'b')) return PromptEditAction.MOVE_CHARACTER_BACKWARD;
  if (key.rightArrow || (key.ctrl && character === 'f')) return PromptEditAction.MOVE_CHARACTER_FORWARD;
  if (key.backspace) return PromptEditAction.DELETE_CHARACTER_BACKWARD;
  if (key.delete || (key.ctrl && character === 'd')) return PromptEditAction.DELETE_CHARACTER_FORWARD;
  return undefined;
}

function deleteRange(text: string, start: number, end: number): PromptEditResult {
  return { text: `${text.slice(0, start)}${text.slice(end)}`, cursor: start };
}

function previousCharacterOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const segment of graphemes.segment(text)) {
    if (segment.index >= offset) break;
    previous = segment.index;
  }
  return previous;
}

function nextCharacterOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  for (const segment of graphemes.segment(text)) {
    if (segment.index > offset) return segment.index;
  }
  return text.length;
}

function previousWordOffset(text: string, offset: number): number {
  const segments = [...graphemes.segment(text)];
  let index = segments.findLastIndex(segment => segment.index < offset);
  while (index >= 0 && !isWordSegment(segments[index]!.segment)) index -= 1;
  while (index >= 0 && isWordSegment(segments[index]!.segment)) index -= 1;
  return segments[index + 1]?.index ?? 0;
}

function nextWordOffset(text: string, offset: number): number {
  const segments = [...graphemes.segment(text)];
  let index = segments.findIndex(segment => segment.index >= offset);
  if (index < 0) return text.length;
  while (index < segments.length && !isWordSegment(segments[index]!.segment)) index += 1;
  while (index < segments.length && isWordSegment(segments[index]!.segment)) index += 1;
  return segments[index]?.index ?? text.length;
}

function isWordSegment(value: string): boolean {
  return wordCharacter.test(value);
}
