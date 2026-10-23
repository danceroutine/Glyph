import { describe, expect, it } from 'vitest';
import { replaceGlyphPromptRange, toGlyphPromptText } from '#src/desktop/workbench/GlyphPromptDocument.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

describe(toGlyphPromptText, () => {
  it('serializes attachments as mentions with an optional line range', () => {
    const file = {
      kind: GlyphContextAttachmentKind.FILE,
      uri: 'file:///project/a.ts',
      path: 'a.ts',
      text: 'file',
      contentRevision: 'r1',
    };
    const selection = {
      ...file,
      kind: GlyphContextAttachmentKind.SELECTION,
      range: { start: { line: 2, column: 1 }, end: { line: 4, column: 1 } },
    };
    expect(
      toGlyphPromptText([
        { type: 'text', text: 'see ' },
        { type: 'attachment', attachment: file },
        { type: 'text', text: ' and ' },
        { type: 'attachment', attachment: selection },
      ]),
    ).toBe('see @a.ts and @a.ts (2-4)');
  });
});

describe(replaceGlyphPromptRange, () => {
  it('replaces the selected span while keeping surrounding atoms and moving the caret after the insertion', () => {
    const attachment = {
      kind: GlyphContextAttachmentKind.FILE,
      uri: 'file:///project/a.ts',
      path: 'a.ts',
      text: 'file',
      contentRevision: 'r1',
    };
    const document = {
      parts: [
        { type: 'attachment' as const, attachment },
        { type: 'text' as const, text: 'abcdef' },
        { type: 'attachment' as const, attachment },
      ],
      from: 2,
      to: 5,
    };
    expect(replaceGlyphPromptRange(document, [{ type: 'text', text: 'XY' }])).toEqual({
      parts: [
        { type: 'attachment', attachment },
        { type: 'text', text: 'a' },
        { type: 'text', text: 'XY' },
        { type: 'text', text: 'ef' },
        { type: 'attachment', attachment },
      ],
      from: 4,
      to: 4,
    });
  });

  it('counts each inserted attachment as a single caret position', () => {
    const attachment = {
      kind: GlyphContextAttachmentKind.FILE,
      uri: 'file:///project/a.ts',
      path: 'a.ts',
      text: 'file',
      contentRevision: 'r1',
    };
    const result = replaceGlyphPromptRange({ parts: [{ type: 'text', text: 'ab' }], from: 1, to: 1 }, [
      { type: 'attachment', attachment },
      { type: 'attachment', attachment },
    ]);
    expect(result.from).toBe(3);
    expect(result.to).toBe(3);
    expect(toGlyphPromptText(result.parts)).toBe('a@a.ts@a.tsb');
  });
});
