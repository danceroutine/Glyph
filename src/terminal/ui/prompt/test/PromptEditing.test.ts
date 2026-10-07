import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { editPrompt, PromptEditAction, promptEditAction } from '../PromptEditing.ts';

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

describe(promptEditAction, () => {
  it.each<[string, string, Partial<EditingKey>, PromptEditAction | undefined]>([
    ['ignores Kitty release events', '', { eventType: 'release', leftArrow: true }, undefined],
    ['maps Cmd+Backspace', '', { super: true, backspace: true }, PromptEditAction.DELETE_LINE_BACKWARD],
    ['maps Cmd+Delete', '', { super: true, delete: true }, PromptEditAction.DELETE_LINE_FORWARD],
    ['maps Ctrl+U', 'u', { ctrl: true }, PromptEditAction.DELETE_LINE_BACKWARD],
    ['maps Ctrl+K', 'k', { ctrl: true }, PromptEditAction.DELETE_LINE_FORWARD],
    ['maps Option+Backspace', '', { meta: true, backspace: true }, PromptEditAction.DELETE_WORD_BACKWARD],
    ['maps Ctrl+Backspace', '', { ctrl: true, backspace: true }, PromptEditAction.DELETE_WORD_BACKWARD],
    ['maps Option+Delete', '', { meta: true, delete: true }, PromptEditAction.DELETE_WORD_FORWARD],
    ['maps Ctrl+Delete', '', { ctrl: true, delete: true }, PromptEditAction.DELETE_WORD_FORWARD],
    ['maps Ctrl+W', 'w', { ctrl: true }, PromptEditAction.DELETE_WORD_BACKWARD],
    ['maps Option+D', 'd', { meta: true }, PromptEditAction.DELETE_WORD_FORWARD],
    ['maps Cmd+Left', '', { super: true, leftArrow: true }, PromptEditAction.MOVE_LINE_BACKWARD],
    ['maps Cmd+Up', '', { super: true, upArrow: true }, PromptEditAction.MOVE_LINE_BACKWARD],
    ['maps Option+Up', '', { meta: true, upArrow: true }, PromptEditAction.MOVE_LINE_BACKWARD],
    ['maps Cmd+Right', '', { super: true, rightArrow: true }, PromptEditAction.MOVE_LINE_FORWARD],
    ['maps Cmd+Down', '', { super: true, downArrow: true }, PromptEditAction.MOVE_LINE_FORWARD],
    ['maps Option+Down', '', { meta: true, downArrow: true }, PromptEditAction.MOVE_LINE_FORWARD],
    ['maps Home', '', { home: true }, PromptEditAction.MOVE_LINE_BACKWARD],
    ['maps Ctrl+A', 'a', { ctrl: true }, PromptEditAction.MOVE_LINE_BACKWARD],
    ['maps End', '', { end: true }, PromptEditAction.MOVE_LINE_FORWARD],
    ['maps Ctrl+E', 'e', { ctrl: true }, PromptEditAction.MOVE_LINE_FORWARD],
    ['maps Ctrl+Left', '', { ctrl: true, leftArrow: true }, PromptEditAction.MOVE_WORD_BACKWARD],
    ['maps Option+Left', '', { meta: true, leftArrow: true }, PromptEditAction.MOVE_WORD_BACKWARD],
    ['maps Ctrl+Right', '', { ctrl: true, rightArrow: true }, PromptEditAction.MOVE_WORD_FORWARD],
    ['maps Option+Right', '', { meta: true, rightArrow: true }, PromptEditAction.MOVE_WORD_FORWARD],
    ['maps Option+B', 'b', { meta: true }, PromptEditAction.MOVE_WORD_BACKWARD],
    ['maps Option+F', 'f', { meta: true }, PromptEditAction.MOVE_WORD_FORWARD],
    ['maps Left', '', { leftArrow: true }, PromptEditAction.MOVE_CHARACTER_BACKWARD],
    ['maps Ctrl+B', 'b', { ctrl: true }, PromptEditAction.MOVE_CHARACTER_BACKWARD],
    ['maps Right', '', { rightArrow: true }, PromptEditAction.MOVE_CHARACTER_FORWARD],
    ['maps Ctrl+F', 'f', { ctrl: true }, PromptEditAction.MOVE_CHARACTER_FORWARD],
    ['maps Backspace', '', { backspace: true }, PromptEditAction.DELETE_CHARACTER_BACKWARD],
    ['maps Delete', '', { delete: true }, PromptEditAction.DELETE_CHARACTER_FORWARD],
    ['maps Ctrl+D', 'd', { ctrl: true }, PromptEditAction.DELETE_CHARACTER_FORWARD],
    ['leaves printable input alone', 'x', {}, undefined],
  ])('%s', (_name, input, keyValue, expected) => {
    expect(promptEditAction(input, key(keyValue))).toBe(expected);
  });
});

describe(editPrompt, () => {
  it.each<[string, string, number, string, Partial<EditingKey>, { text: string; cursor: number }]>([
    ['moves backward by grapheme', 'Ae\u0301B', 3, '', { leftArrow: true }, { text: 'Ae\u0301B', cursor: 1 }],
    ['moves forward by grapheme', 'Ae\u0301B', 1, '', { rightArrow: true }, { text: 'Ae\u0301B', cursor: 3 }],
    [
      'moves to the previous word',
      'alpha  beta.gamma',
      17,
      '',
      { meta: true, leftArrow: true },
      { text: 'alpha  beta.gamma', cursor: 12 },
    ],
    [
      'moves across separators to the next word end',
      'alpha  beta.gamma',
      5,
      '',
      { meta: true, rightArrow: true },
      { text: 'alpha  beta.gamma', cursor: 11 },
    ],
    ['moves to line start', 'alpha beta', 6, '', { super: true, leftArrow: true }, { text: 'alpha beta', cursor: 0 }],
    ['moves to line end', 'alpha beta', 2, '', { super: true, rightArrow: true }, { text: 'alpha beta', cursor: 10 }],
    ['deletes one grapheme backward', 'Ae\u0301B', 3, '', { backspace: true }, { text: 'AB', cursor: 1 }],
    ['deletes one grapheme forward', 'Ae\u0301B', 1, '', { delete: true }, { text: 'AB', cursor: 1 }],
    [
      'deletes the previous word',
      'alpha  beta.gamma',
      17,
      '',
      { meta: true, backspace: true },
      { text: 'alpha  beta.', cursor: 12 },
    ],
    [
      'deletes through the next word',
      'alpha  beta.gamma',
      5,
      '',
      { meta: true, delete: true },
      { text: 'alpha.gamma', cursor: 5 },
    ],
    ['deletes to line start', 'alpha beta', 6, '', { super: true, backspace: true }, { text: 'beta', cursor: 0 }],
    ['deletes to line end', 'alpha beta', 5, '', { super: true, delete: true }, { text: 'alpha', cursor: 5 }],
  ])('%s', (_name, text, cursor, input, keyValue, expected) => {
    expect(editPrompt(input, key(keyValue), text, cursor)).toEqual(expected);
  });

  it('keeps boundary edits stable and ignores non-editing keys', () => {
    expect(editPrompt('', key({ backspace: true }), 'text', 0)).toEqual({ text: 'text', cursor: 0 });
    expect(editPrompt('', key({ delete: true }), 'text', 4)).toEqual({ text: 'text', cursor: 4 });
    expect(editPrompt('', key({ meta: true, leftArrow: true }), '...', 3)).toEqual({ text: '...', cursor: 0 });
    expect(editPrompt('', key({ meta: true, rightArrow: true }), '...', 0)).toEqual({ text: '...', cursor: 3 });
    expect(editPrompt('', key({ meta: true, leftArrow: true }), 'text', 0)).toEqual({ text: 'text', cursor: 0 });
    expect(editPrompt('', key({ meta: true, rightArrow: true }), 'text', 4)).toEqual({ text: 'text', cursor: 4 });
    expect(editPrompt('', key({ meta: true, leftArrow: true }), '', 0)).toEqual({ text: '', cursor: 0 });
    expect(editPrompt('x', key(), 'text', 2)).toBeUndefined();
  });
});

function key(overrides: Partial<EditingKey> = {}): EditingKey {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    end: false,
    home: false,
    leftArrow: false,
    meta: false,
    rightArrow: false,
    super: false,
    upArrow: false,
    downArrow: false,
    ...overrides,
  };
}
