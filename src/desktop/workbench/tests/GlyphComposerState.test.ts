import { describe, expect, it } from 'vitest';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

const attachment = {
  id: 'selection',
  kind: GlyphContextAttachmentKind.SELECTION,
  uri: 'file:///project/a.ts',
  path: 'a.ts',
  text: '  café 🌱\r\n\tline',
  contentRevision: 'captured-hash',
  sourceRevision: 'model:1',
  token: { workspaceGeneration: 'workspace', resource: 'file:///project/a.ts', incarnation: 'model', version: 1 },
  range: { start: { line: 2, column: 1 }, end: { line: 3, column: 6 } },
};

describe(GlyphComposerState, () => {
  it('inserts captures at the saved selection and removes only that atom, mapping the caret', () => {
    const model = new GlyphComposerState();
    model.setDocument({ parts: [{ type: 'text', text: 'before replace after' }], from: 7, to: 14 });
    model.insertAttachments([attachment]);
    expect(model.snapshot.draft).toBe('before @a.ts (2-3) after');
    expect(model.snapshot.document.from).toBe(8);
    model.replaceAttachment('selection');
    expect(model.snapshot.draft).toBe('before  after');
    expect(model.snapshot.document.from).toBe(7);
  });
  it('keeps exact captures and order when a failed send is restored alongside a newer draft', async () => {
    const model = new GlyphComposerState();
    model.setDraft('inspect ');
    model.insertAttachments([attachment]);
    const original = model.snapshot.document;
    let reject!: (reason: Error) => void;
    const pending = model.submit((text, attachments) => {
      expect(text).toBe('inspect @a.ts (2-3)');
      expect(attachments).toEqual([attachment]);
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    model.setDraft('next message');
    reject(new Error('Offline'));
    await pending;
    expect(model.snapshot.draft).toBe('next message');
    model.editUnsent(0);
    expect(model.snapshot.document).toEqual(original);
    expect(model.snapshot.unsent).toEqual(['next message']);
    await model.submit(async (_text, attachments) => {
      expect(attachments).toEqual([attachment]);
    });
  });
});
