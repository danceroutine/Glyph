import { describe, expect, it } from 'vitest';
import { toGlyphTranscriptParts } from '#src/desktop/workbench/toGlyphTranscriptParts.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

const attachment = { path: 'a.ts', text: 'captured', revision: '1' };
const entry = {
  id: 'turn',
  role: GlyphTranscriptRole.USER,
  text: 'Mention @a.ts then inspect @a.ts please',
  attachments: [attachment],
};
describe(toGlyphTranscriptParts, () => {
  it('uses saved positions to distinguish a badge from identical plain text', () => {
    expect(toGlyphTranscriptParts({ ...entry, options: { attachmentSpans: [{ from: 27, to: 32 }] } })).toEqual([
      { type: 'text', text: 'Mention @a.ts then inspect ' },
      { type: 'attachment', attachment },
      { type: 'text', text: ' please' },
    ]);
  });
  it('renders older saved mentions inline', () => {
    expect(toGlyphTranscriptParts({ ...entry, text: 'Inspect @a.ts please' })).toEqual([
      { type: 'text', text: 'Inspect ' },
      { type: 'attachment', attachment },
      { type: 'text', text: ' please' },
    ]);
  });
  it('preserves text and provides a badge when no valid mention is available', () => {
    expect(
      toGlyphTranscriptParts({ ...entry, text: 'Inspect', options: { attachmentSpans: [{ from: 0, to: 100 }] } }),
    ).toEqual([
      { type: 'text', text: 'Inspect' },
      { type: 'text', text: ' ' },
      { type: 'attachment', attachment },
    ]);
  });
  it('renders a message without attachments as a single text part', () => {
    expect(toGlyphTranscriptParts({ id: 'turn', role: GlyphTranscriptRole.USER, text: 'Plain message' })).toEqual([
      { type: 'text', text: 'Plain message' },
    ]);
  });
  it('renders ranged mentions that begin and end the message without empty text parts', () => {
    const ranged = {
      path: 'b.ts',
      text: 'selected',
      revision: '2',
      range: { start: { line: 3, column: 1 }, end: { line: 5, column: 1 } },
    };
    expect(
      toGlyphTranscriptParts({
        id: 'turn',
        role: GlyphTranscriptRole.USER,
        text: '@b.ts (3-5)',
        attachments: [ranged],
      }),
    ).toEqual([{ type: 'attachment', attachment: ranged }]);
  });
});
