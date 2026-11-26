import { describe, expect, it, vi } from 'vitest';
import { restoreGlyphPrompt } from '#src/desktop/workbench/restoreGlyphPrompt.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { toGlyphPromptText, type GlyphPromptPart } from '#src/desktop/workbench/GlyphPromptDocument.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { ChatTurnOptions } from '#src/chat/ChatTurnOptions.js';

const rule: GlyphContextAttachment = {
  kind: GlyphContextAttachmentKind.RULE,
  ruleId: 'rule',
  path: 'Use',
  uri: 'glyph-rule:rule',
  text: '',
  contentRevision: 'r1',
};
const file: GlyphContextAttachment = {
  kind: GlyphContextAttachmentKind.FILE,
  path: 'a.ts',
  uri: 'file:///project/a.ts',
  text: 'captured bytes',
  contentRevision: 'file-r1',
  id: 'file',
};

describe(restoreGlyphPrompt, () => {
  it('excludes a malformed rule reference from selected IDs, captured bytes and spans', async () => {
    const composer = new GlyphComposerState();
    const { ruleId: _missing, ...malformed } = rule;
    composer.setDocument({ parts: [{ type: 'attachment', attachment: malformed }], from: 0, to: 0 });
    await composer.submit(async (_text, attachments, options) => {
      expect(attachments).toEqual([]);
      expect(options?.manualRuleIds).toBeUndefined();
      expect(options?.referenceSpans).toBeUndefined();
    });
  });
  it('round-trips interleaved captures, literal mentions and repeated rule badges at trimmed UTF-16 positions', async () => {
    const composer = new GlyphComposerState();
    const parts: GlyphPromptPart[] = [
      { type: 'text', text: '  🪴 /Use then ' },
      { type: 'attachment', attachment: rule },
      { type: 'text', text: ' before ' },
      { type: 'attachment', attachment: file },
      { type: 'text', text: ' and ' },
      { type: 'attachment', attachment: rule },
    ];
    composer.setDocument({ parts, from: 0, to: 0 });
    let captured!: { text: string; attachments: readonly GlyphContextAttachment[]; options: ChatTurnOptions };
    await composer.submit(async (text, attachments, options) => {
      captured = { text: text.trim(), attachments, options: options! };
    });
    expect(captured.attachments).toEqual([file]);
    expect(captured.options.manualRuleIds).toEqual(['rule']);
    expect(
      captured.options.referenceSpans?.map(ref => [
        ref.kind,
        ref.sourceId,
        ref.revision,
        captured.text.slice(ref.from, ref.to),
      ]),
    ).toEqual([
      ['rule', 'rule', 'r1', '/Use'],
      ['rule', 'rule', 'r1', '/Use'],
    ]);
    const resolve = vi.fn();
    const restored = restoreGlyphPrompt(captured, resolve, () => 'badge');
    expect(resolve).not.toHaveBeenCalled();
    expect(restored.parts).toEqual([
      { type: 'text', text: '🪴 /Use then ' },
      { type: 'attachment', attachment: { ...rule, id: 'badge' } },
      { type: 'text', text: ' before ' },
      { type: 'attachment', attachment: file },
      { type: 'text', text: ' and ' },
      { type: 'attachment', attachment: { ...rule, id: 'badge' } },
    ]);
    expect(toGlyphPromptText(restored.parts)).toBe(captured.text);
    composer.restoreDraft(restored);
    // This also exercises a host/draft that retained the original derived options.
    composer.setDocument({
      parts: [{ type: 'text', text: 'Only text /Use' }],
      from: 0,
      to: 0,
      options: captured.options,
    });
    await composer.submit(async (text, attachments, options) => {
      expect(text).toBe('Only text /Use');
      expect(attachments).toEqual([]);
      expect(options?.referenceSpans).toBeUndefined();
      expect(options?.manualRuleIds).toBeUndefined();
      expect(options?.attachmentSpans).toBeUndefined();
    });
  });

  it('restores only selected IDs and appends visible badges for ambiguous or unavailable legacy mentions', () => {
    const text = '/Use /Same /Same /Similar';
    const options: ChatTurnOptions = {
      manualRuleIds: ['rule', 'second', 'third', 'missing'],
      referenceSpans: [{ kind: 'rule', sourceId: 'unselected', label: 'Same', revision: 'fake', from: 5, to: 10 }],
    };
    const document = restoreGlyphPrompt(
      { text, attachments: [], options },
      (_kind, id) =>
        id === 'rule' ? { name: 'Use', revision: 'one' } : id === 'missing' ? undefined : { name: 'Same' },
      () => 'badge',
    );
    expect(
      document.parts.map(part => (part.type === 'text' ? part.text : [part.attachment.ruleId, part.attachment.text])),
    ).toEqual([['rule', ''], ' /Same /Same /Similar', ' ', ['second', ''], ' ', ['third', ''], ' ', ['missing', '']]);
    expect(restoreGlyphPrompt({ text: 'plain', attachments: [] }, vi.fn(), () => 'badge').parts).toEqual([
      { type: 'text', text: 'plain' },
    ]);
  });
  it('keeps a slash within a URL or a longer word as literal legacy text', () => {
    for (const text of ['https://example.test/Use', '/Useful']) {
      const restored = restoreGlyphPrompt(
        { text, attachments: [], options: { manualRuleIds: ['rule'] } },
        () => ({ name: 'Use' }),
        () => 'id',
      );
      expect(restored.parts[0]).toEqual({ type: 'text', text });
      expect(restored.parts.at(-1)).toMatchObject({ type: 'attachment', attachment: { ruleId: 'rule' } });
    }
  });
});
